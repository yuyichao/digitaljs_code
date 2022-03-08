//

'use strict';

import * as vscode from 'vscode';
import * as unicode from './unicode_utils.mjs';

function array_equal(a, b) {
    const len = a.length;
    if (b.length !== len)
        return false;
    for (let i = 0; i < len; i++) {
        if (a[i] != b[i]) {
            return false;
        }
    }
    return true;
}

// # Note
// * When we outputted a full line, the cursor will at a funny state.
//   When trying to move the cursor, it would be as if the cursor is one character
//   before the end, but when trying to print something,
//   it would be as if the cursor is at the start of the next line.
//   Because of this, we don't really want to leave the cursor in this state.
//   Instead, we would move the cursor to the start of the next line.
// * If the cursor is at the end of a line but it is not the last line,
//   different REPL seems to behave differently.
//   The Julia REPL will not create an empty line and will draw the cursor
//   at the beginning of the next line whereas all the other REPL's
//   I've tested (bash, zsh, (i)python,) will draw an empty line in this case.
//   Let's follow the majority in this case. The disadvantage is that
//   there can be empty lines on the screen...
//   In order to implement this without adding an empty line when trying
//   to copy from the screen, the trick is to output a space to force line wrapping
//   and then use `\r\e[K` to clear the line. (copied from the output of zsh).

class Line {
    text = ''
    #sublinewrap = []
    constructor(text = '') {
        this.text = text;
    }
    get nsublines() {
        return this.#sublinewrap.length + 1;
    }
    subline_start(subline) {
        if (subline <= 0)
            return 0;
        if (subline > this.#sublinewrap.length)
            return this.text.length;
        return this.#sublinewrap[subline - 1];
    }
    subline_width(subline) {
        return unicode.getSubStringLength(this.text, this.subline_start(subline),
                                          this.subline_start(subline + 1));
    }
    // Recompute where all the line wraps are supposed to be.
    rewrap(column, start_idx = 0) {
        const lw = [];
        let idx = 0;
        for (const wrap of this.#sublinewrap) {
            if (wrap > start_idx)
                break;
            lw.push(wrap);
            idx = wrap;
        }
        const text = this.text;
        let line_len = 0;
        const length = text.length;
        for (; idx < length;) {
            const [disp_len, idx_len] = unicode.getLengthAt(text, idx);
            if (line_len + disp_len > column) {
                lw.push(idx);
                line_len = 0;
            }
            line_len += disp_len;
            idx += idx_len;
        }
        if (line_len == column) // Empty line if the last line is full
            lw.push(idx);
        const changed = array_equal(this.#sublinewrap, lw);
        this.#sublinewrap = lw;
        return changed;
    }
    has_force_wrap() {
        return this.#sublinewrap.length > 0 &&
               this.#sublinewrap[this.#sublinewrap.length - 1] === this.text.length;
    }
    // The output to draw the text in this line from `start_idx`
    draw_text(start_idx) {
        const text = this.text.substring(start_idx);
        if (this.has_force_wrap())
            return text + ' \r\x1b[K'; // Force wrap line
        return text;
    }
    #locate_cursor_line(idx) {
        const lw = this.#sublinewrap;
        const nlw = lw.length;
        if (nlw == 0 || idx < lw[0])
            return [0, 0];
        let lo = 0;
        let hi = nlw - 1;
        // Find the last line index that starts no greater than idx
        while (hi > lo) {
            const mid = (lo + hi) >> 1;
            const line_start = lw[mid];
            if (idx == line_start) {
                return [mid + 1, line_start];
            }
            else if (idx > line_start) {
                lo = mid + 1;
            }
            else {
                hi = mid - 1;
            }
        }
        return [lo + 1, lw[lo]];
    }
    // Find the coordinate relative to the start of the line
    locate_cursor(idx) {
        let [line, offset] = this.#locate_cursor_line(idx);
        const text = this.text;
        let line_pos = 0;
        while (offset < text.length) {
            const [disp_len, idx_len] = unicode.getLengthAt(text, offset);
            offset += idx_len;
            if (offset > idx)
                return [line, line_pos];
            line_pos += disp_len;
        }
        return [line, line_pos];
    }
    // Find the coordinate relative to the start of the line
    find_index(line, line_pos) {
        const text = this.text;
        const line_start = line == 0 ? 0 : this.#sublinewrap[line];
        const line_end = (line >= this.#sublinewrap.length - 1 ? text.length :
                          this.#sublinewrap[line + 1]);
        let p = 0;
        for (let idx = line_start; idx < line_end;) {
            const [disp_len, idx_len] = unicode.getLengthAt(text, idx);
            p += disp_len;
            if (p > line_pos)
                return [idx, p - disp_len];
            idx += idx_len;
        }
        return [line_end, p];
    }
    // Cursor move functions
    cursor_right(subline, idx) {
        if (idx >= this.text.length)
            return [CursorMoveType.ChangeLine];
        const line_end = this.subline_start(subline + 1);
        const [disp_len, idx_len] = unicode.getLengthAt(this.text, idx);
        const new_lineidx = idx + idx_len;
        // Still not at the end or end of last line, simply move forward
        if (new_lineidx < line_end || (line_end == this.text.length && !this.has_force_wrap()))
            return [CursorMoveType.SameLine, disp_len, idx_len];
        return [CursorMoveType.ChangeSubline, 0, idx_len];
    }
    cursor_left(subline, idx, prefix_idxlen) {
        if (idx <= prefix_idxlen)
            return [CursorMoveType.ChangeLine];
        const line_start = this.subline_start(subline);
        const [disp_len, idx_len] = unicode.getLengthBefore(this.text, idx);
        // Still not at the end or end of last line, simply move forward
        if (idx > line_start)
            return [CursorMoveType.SameLine, disp_len, idx_len];
        const new_col = this.subline_width(subline - 1) - disp_len;
        return [CursorMoveType.ChangeSubline, new_col, idx_len];
    }
}

class Cursor {
    line = 0 // Input line
    lineidx = 0 // Position within input line
    subline = 0 // Wrapped line number within an input line
    pos = [0, 0] // Coordinate on screen relative to start of REPL
}

// Special keys to handle:
// Left/right, Ctrl-B/F: move cursor
// Up/down, Ctrl-P/N: move cursor or switch between history
// Mouse click: move cursor
// Mouse scrolling: move cursor?
// Home/End, Ctrl-A/E: move cursor
// Backspace: delete before cursor
// Alt-Enter: new line
// Enter: try-submit
// Delete, Ctrl-D: delete after cursor
// Ctrl-K: delete till end of line
// Ctrl-Y: paste?

class CursorMoveType {
    static None = 0
    static SameLine = 1
    static ChangeSubline = 2
    static ChangeLine = 3
}

export default class REPL {
    onDidChangeName
    #onDidChangeName
    onDidClose
    #onDidClose
    // onDidOverrideDimensions
    // #onDidOverrideDimensions
    onDidWrite
    #onDidWrite
    onDidDispose
    #onDidDispose

    #prompt_cb
    #ps_len
    #ps0
    #ps1

    #columns
    #lines = []
    #cursor
    #repl_line = 0
    #print_col = 0

    #cursor_cb = []
    constructor(prompt_cb, ps0, ps1) {
        this.#prompt_cb = prompt_cb;
        const ps0_len = unicode.getSubStringLength(ps0, 0, ps0.length);
        const ps1_len = unicode.getSubStringLength(ps1, 0, ps1.length);
        console.assert(ps0_len >= ps1_len);
        ps1 += ' '.repeat(ps0_len - ps1_len);
        this.#ps_len = ps0_len;
        this.#ps0 = ps0;
        this.#ps1 = ps1;
        this.#onDidChangeName = new vscode.EventEmitter();
        this.onDidChangeName = this.#onDidChangeName.event;
        this.#onDidClose = new vscode.EventEmitter();
        this.onDidClose = this.#onDidClose.event;
        // this.#onDidOverrideDimensions = new vscode.EventEmitter();
        // this.onDidOverrideDimensions = this.#onDidOverrideDimensions.event;
        this.#onDidWrite = new vscode.EventEmitter();
        this.onDidWrite = this.#onDidWrite.event;
        this.#onDidDispose = new vscode.EventEmitter();
        this.onDidDispose = this.#onDidDispose.event;
        this.#cursor = new Cursor();
    }

    // vscode interface
    open(dims) {
        this.#columns = dims.columns;
        this.#new_prompt();
    }
    close() {
        this.#onDidDispose.fire();
    }
    handleInput(data) {
        if (data.startsWith('\x1b[')) {
            const cmd = data.substring(2);
            const cursor = cmd.match(/^(\d+);(\d+)R$/);
            if (cursor) {
                for (const cb of this.#cursor_cb)
                    cb(cursor[2] - 1);
                this.#cursor_cb.length = 0;
                return;
            }
            if (cmd === 'A') {
                return this.#cursor_up();
            }
            else if (cmd === 'B') {
                return this.#cursor_down();
            }
            else if (cmd === 'C') {
                return this.#cursor_right();
            }
            else if (cmd === 'D') {
                return this.#cursor_left();
            }
            else if (cmd === 'H') {
                return this.#cursor_begin_of_line();
            }
            else if (cmd === 'F') {
                return this.#cursor_end_of_line();
            }
            else if (cmd === '3~') {
                return this.#delete_after();
            }
            // Unknown command, ignore.
            if (cmd.match(/^[0-9;]*[a-zA-Z]$/))
                return;
            // Otherwise fall through.
        }
        if (data === '\x10') {
            return this.#cursor_up();
        }
        else if (data === '\x0e') {
            return this.#cursor_down();
        }
        else if (data === '\x06') {
            return this.#cursor_right();
        }
        else if (data === '\x02') {
            return this.#cursor_left();
        }
        else if (data === '\x01') {
            return this.#cursor_begin_of_line();
        }
        else if (data === '\x05') {
            return this.#cursor_end_of_line();
        }
        else if (data === '\x04') {
            return this.#delete_after();
        }
        else if (data === '\x7f') {
            return this.#delete_before();
        }
        else if (data === '\x0b') {
            return this.#kill_line();
        }
        else if (data === '\r') {
            return this.#try_submit();
        }
        else if (data === '\x1b\r') {
            return this.#new_line();
        }
        this.#input_text(data);
    }
    setDimensions(dims) {
        if (this.#columns == dims.columns)
            return;
        this.#columns = dims.columns;
        this.#rewrap_lines();
    }

    // Basic terminal functions
    #write(data) {
        if (data.length === 0)
            return;
        this.#onDidWrite.fire(data);
    }
    #do_cursor_up(n = 1) {
        if (n == 0)
            return;
        if (n < 0)
            return this.#do_cursor_down(-n);
        this.#write(n == 1 ? `\x1b[A`: `\x1b[${n}A`);
    }
    #do_cursor_down(n = 1) {
        if (n == 0)
            return;
        if (n < 0)
            return this.#do_cursor_up(-n);
        this.#write(n == 1 ? `\x1b[B`: `\x1b[${n}B`);
    }
    #do_cursor_right(n = 1) {
        if (n == 0)
            return;
        if (n < 0)
            return this.#do_cursor_left(-n);
        this.#write(n == 1 ? `\x1b[C`: `\x1b[${n}C`);
    }
    #do_cursor_left(n = 1) {
        if (n == 0)
            return;
        if (n < 0)
            return this.#do_cursor_right(-n);
        this.#write(n == 1 ? `\x1b[D`: `\x1b[${n}D`);
    }
    #do_cursor_start_of_line() {
        this.#write('\r');
    }
    #do_cursor_start_of_nextline() {
        this.#write('\r\n');
    }
    #do_cursor_start_of_prevline() {
        this.#write('\r\x1b[A');
    }
    #do_kill_line() {
        this.#write(`\x1b[K`);
    }
    #do_clear_end_of_screen() {
        this.#write(`\x1b[J`);
    }
    #get_cursor_col() {
        this.#write(`\x1b[6n`);
        return new Promise((resolve) => {
            this.#cursor_cb.push(resolve);
        });
    }

    // Terminal function with buffer management
    #cursor_right() {
        // No input yet
        if (this.#lines.length == 0)
            return;
        const line = this.#lines[this.#cursor.line];
        const linemove = line.cursor_right(this.#cursor.subline, this.#cursor.lineidx);
        if (linemove[0] === CursorMoveType.SameLine) {
            // Still not at the end, simply move forward
            this.#do_cursor_right(linemove[1]);
            this.#cursor.lineidx += linemove[2];
            this.#cursor.pos[1] += linemove[1];
            return;
        }
        else if (linemove[0] === CursorMoveType.ChangeSubline) {
            this.#do_cursor_start_of_nextline();
            this.#cursor.lineidx += linemove[2];
            this.#cursor.subline += 1;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = 0;
            return;
        }
        // Last line, nothing to do
        if (this.#cursor.line >= this.#lines.length - 1)
            return;
        // Move to the next line
        this.#do_cursor_start_of_nextline();
        this.#cursor.line += 1;
        this.#cursor.lineidx = 0;
        this.#cursor.subline = 0;
        this.#cursor.pos[0] += 1;
        this.#cursor.pos[1] = 0;
    }
    #cursor_left() {
        // No input yet
        if (this.#lines.length == 0)
            return;
        const line = this.#lines[this.#cursor.line];
        const prefix_idxlen = this.#cursor.line == 0 ? this.#ps0.length : this.#ps1.length;
        const linemove = line.cursor_left(this.#cursor.subline, this.#cursor.lineidx,
                                          prefix_idxlen);
        if (linemove[0] === CursorMoveType.SameLine) {
            // Still not at the end, simply move forward
            this.#do_cursor_left(linemove[1]);
            this.#cursor.lineidx -= linemove[2];
            this.#cursor.pos[1] -= linemove[1];
            return;
        }
        else if (linemove[0] === CursorMoveType.ChangeSubline) {
            this.#do_cursor_start_of_prevline();
            this.#do_cursor_right(linemove[1]);
            this.#cursor.lineidx -= linemove[2];
            this.#cursor.subline -= 1;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = linemove[1];
            return;
        }
        // First line, nothing to do
        if (this.#cursor.line == 0)
            return;
        // Move to the next line
        this.#do_cursor_start_of_nextline();
        this.#cursor.line += 1;
        this.#cursor.lineidx = 0;
        this.#cursor.subline = 0;
        this.#cursor.pos[0] += 1;
        this.#cursor.pos[1] = 0;

        // Move to the prev line
        this.#cursor.line -= 1;
        const newline = this.#lines[this.#cursor.line];
        this.#cursor.subline = newline.nsublines - 1;
        const new_col = newline.subline_width(this.#cursor.subline);
        this.#do_cursor_start_of_prevline();
        this.#do_cursor_right(new_col);
        this.#cursor.lineidx = newline.text.length;
        this.#cursor.pos[0] -= 1;
        this.#cursor.pos[1] = new_col;
    }
    // TODO history
    #cursor_up() {
        // No input yet
        if (this.#lines.length == 0)
            return;
        let curcol = this.#cursor.pos[1];
        if (this.#cursor.subline > 0) {
            const line = this.#lines[this.#cursor.line];
            // Move up within the line
            this.#cursor.subline -= 1;
            if (this.#cursor.subline == 0 && curcol < this.#ps_len)
                curcol = this.#ps_len;
            const [newidx, newpos] = line.find_index(this.#cursor.subline, curcol);
            this.#do_cursor_up(1);
            this.#do_cursor_right(newpos - this.#cursor.pos[1]);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = newpos;
            return;
        }
        // First line already, move to start of line
        if (this.#cursor.line == 0)
            return this.#cursor_begin_of_line();
        // Move to previous line
        this.#cursor.line -= 1;
        const line = this.#lines[this.#cursor.line];
        this.#cursor.subline = line.nsublines - 1;
        if (this.#cursor.subline == 0 && curcol < this.#ps_len)
            curcol = this.#ps_len;
        const [newidx, newpos] = line.find_index(line.nsublines - 1, curcol);
        this.#do_cursor_up(1);
        this.#do_cursor_right(newpos - this.#cursor.pos[1]);
        this.#cursor.lineidx = newidx;
        this.#cursor.pos[0] -= 1;
        this.#cursor.pos[1] = newpos;
    }
    #cursor_down() {
        // No input yet
        if (this.#lines.length == 0)
            return;
        const line = this.#lines[this.#cursor.line];
        if (this.#cursor.subline < line.nsublines - 1) {
            // Move down within the line
            this.#cursor.subline += 1;
            const [newidx, newpos] = line.find_index(this.#cursor.subline,
                                                     this.#cursor.pos[1]);
            this.#do_cursor_down(1);
            this.#do_cursor_right(newpos - this.#cursor.pos[1]);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = newpos;
            return;
        }
        // Last line already, move to end of line
        if (this.#cursor.line >= this.#lines.length - 1)
            return this.#cursor_end_of_line();
        // Move to next line
        this.#cursor.line += 1;
        const newline = this.#lines[this.#cursor.line];
        this.#cursor.subline = 0;
        let curcol = this.#cursor.pos[1];
        if (curcol < this.#ps_len)
            curcol = this.#ps_len;
        const [newidx, newpos] = newline.find_index(0, curcol);
        this.#do_cursor_down(1);
        this.#do_cursor_right(newpos - this.#cursor.pos[1]);
        this.#cursor.lineidx = newidx;
        this.#cursor.pos[0] += 1;
        this.#cursor.pos[1] = newpos;
    }
    #cursor_begin_of_line() {
        if (this.#lines.length == 0)
            return;
        const line = this.#lines[this.#cursor.line];
        const prefix_idxlen = this.#cursor.line == 0 ? this.#ps0.length : this.#ps1.length;
        this.#do_cursor_left(this.#cursor.pos[1] - this.#ps_len);
        this.#do_cursor_up(this.#cursor.subline);
        this.#cursor.lineidx = prefix_idxlen;
        this.#cursor.pos[0] -= this.#cursor.subline;
        this.#cursor.pos[1] = this.#ps_len;
        this.#cursor.subline = 0;
    }
    #cursor_end_of_line() {
        if (this.#lines.length == 0)
            return;
        const line = this.#lines[this.#cursor.line];
        const width = line.subline_width(line.nsublines - 1);
        this.#cursor.lineidx = line.text.length;
        this.#do_cursor_right(width - this.#cursor.pos[1]);
        const ndown = line.nsublines - this.#cursor.subline - 1;
        this.#do_cursor_down(ndown);
        this.#cursor.subline = line.nsublines - 1;
        this.#cursor.pos[0] += ndown;
        this.#cursor.pos[1] = width;
    }
    #delete_before() {
        const curline = this.#lines[this.#cursor.line];
        const prefix_idxlen = this.#cursor.line == 0 ? this.#ps0.length : this.#ps1.length;
        let redraw_lineidx = this.#cursor.lineidx - 1;
        if (redraw_lineidx < prefix_idxlen) {
            if (this.#cursor.line <= 0)
                return;
            // Merge with previous line
            const curline = this.#lines[this.#cursor.line];
            const prevline = this.#lines[this.#cursor.line - 1];
            this.#cursor.lineidx = prevline.text.length;
            prevline.text = prevline.text + curline.text.substring(this.#ps1.length);
            this.#lines.splice(this.#cursor.line, 1);
            this.#cursor.line -= 1;
            this.#rewrap_lines([this.#cursor.line, this.#cursor.line + 1],
                               [this.#cursor.line, this.#lines.length], true);
            return;
        }
        const curline_suffix = curline.text.substring(redraw_lineidx + 1);
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        if (unicode.isLowSurrogate(curline.text.charCodeAt(redraw_lineidx)) &&
            redraw_lineidx - 1 >= prefix_idxlen)
            redraw_lineidx -= 1;
        curline.text = curline_prefix + curline_suffix;
        this.#redraw_cursor_line(redraw_lineidx, this.#cursor.lineidx - 1, true);
    }
    #delete_newline() {
        // Assume cursor is at the end of the current line.
        // Last line, nothing to do
        if (this.#cursor.line >= this.#lines.length - 1)
            return;
        // Merge with next line
        const curline = this.#lines[this.#cursor.line];
        const nextline = this.#lines[this.#cursor.line + 1];
        curline.text = curline.text + nextline.text.substring(this.#ps1.length);
        this.#lines.splice(this.#cursor.line + 1, 1);
        this.#rewrap_lines([this.#cursor.line, this.#cursor.line + 1],
                           [this.#cursor.line, this.#lines.length], true);
    }
    #delete_after() {
        const curline = this.#lines[this.#cursor.line];
        const redraw_lineidx = this.#cursor.lineidx;
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        // Delete end of line
        if (redraw_lineidx >= curline.text.length)
            return this.#delete_newline();
        const curline_suffix = curline.text.substring(redraw_lineidx + 1);
        curline.text = curline_prefix + curline_suffix;
        this.#redraw_cursor_line(redraw_lineidx, this.#cursor.lineidx, true);
    }
    #kill_line() {
        const curline = this.#lines[this.#cursor.line];
        const redraw_lineidx = this.#cursor.lineidx;
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        // Delete end of line
        if (redraw_lineidx >= curline.text.length)
            return this.#delete_newline();
        curline.text = curline_prefix;
        this.#redraw_cursor_line(redraw_lineidx, this.#cursor.lineidx, true);
    }
    #new_line() {
        this.#input_text('\n');
    }
    #try_submit() {
        let text = this.#lines[0].text.substring(this.#ps0.length);
        const ninput_lines = this.#lines.length;
        for (let lineno = 1; lineno < ninput_lines; lineno++)
            text += '\n' + this.#lines[lineno].text.substring(this.#ps1.length);
        if (!this.#prompt_cb(text))
            return;
        this.#do_cursor_down(this.#count_lines(this.#cursor.line, ninput_lines) -
                             this.#cursor.subline - 1);
        this.#do_cursor_start_of_nextline();
        this.#cursor.pos[0] = 0;
        this.#new_prompt();
    }
    #input_text(data) {
        // Normalize new line, remove control charaters that aren't \t or \n
        // Replace \t with four spaces since I don't really want to handle tabs...
        data = data.replaceAll(/\r\n/g, '\n').replaceAll(/\r/g, '\n')
                   .replaceAll(/[\x00-\x08\x0b-\x1f]*/g, '')
                   .replaceAll(/\t/g, '    ');
        const lines = data.split('\n');
        const curline = this.#lines[this.#cursor.line];
        const redraw_lineidx = this.#cursor.lineidx;
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        const curline_suffix = curline.text.substring(redraw_lineidx);
        if (lines.length == 1) {
            const new_text = lines[0];
            const cursor_lineidx = redraw_lineidx + new_text.length;
            curline.text = curline_prefix + new_text + curline_suffix;
            this.#redraw_cursor_line(redraw_lineidx, cursor_lineidx);
        }
        else {
            curline.text = curline_prefix + lines[0];
            const old_lineno = this.#cursor.line;
            for (let idx = 1; idx < lines.length - 1; idx++)
                this.#lines.splice(old_lineno + idx, 0, new Line(this.#ps1 + lines[idx]));
            const pre_cursor = this.#ps1 + lines[lines.length - 1];
            this.#lines.splice(old_lineno + lines.length - 1, 0,
                               new Line(pre_cursor + curline_suffix));
            this.#cursor.line = old_lineno + lines.length - 1;
            this.#cursor.lineidx = pre_cursor.length;
            const range = [old_lineno, old_lineno + lines.length];
            this.#rewrap_lines(range, range, true);
        }
    }
    #new_prompt() {
        // Assume that `this.#cursor.pos[0]` is set already.
        this.#lines = [new Line(this.#ps0)];
        this.#print_col = 0;
        this.#cursor.line = 0;
        this.#cursor.lineidx = this.#ps0.length;
        this.#rewrap_lines(undefined, [0, 1], true);
    }

    // Terminal utility functions
    #count_lines(start, end) {
        let res = 0;
        for (let lineno = start; lineno < end; lineno++)
            res += this.#lines[lineno].nsublines;
        return res;
    }
    #redraw_lines(from_line) {
        // Lines are assumed to be wrapped and cursor is assumed to be up-to-date.
        this.#do_clear_end_of_screen();
        const nlines = this.#lines.length;
        for (let lineno = from_line; lineno < nlines; lineno++) {
            this.#write(this.#lines[lineno].draw_text(0));
            this.#do_cursor_start_of_nextline();
        }
        this.#do_cursor_up(this.#count_lines(this.#cursor.line, nlines) - this.#cursor.subline);
        this.#do_cursor_right(this.#cursor.pos[1]);
    }
    #redraw_cursor_line(redraw_lineidx, cursor_lineidx, deleted) {
        // Assume cursor is at `this.#cursor` and assume everything about the line
        // hasn't change before `redraw_lineidx`.
        // Rewrap and redraw the cursor line (from redraw_lineidx)

        // If the number of lines is changed after wrapping,
        // the lines following the cursor line will be redrawn.

        // The cursor will be placed at cursor_lineidx on the cursor line.
        const line = this.#lines[this.#cursor.line];
        const last_line = this.#cursor.line === this.#lines.length - 1;
        const old_nsublines = line.nsublines;
        line.rewrap(this.#columns, redraw_lineidx);
        const new_nsublines = line.nsublines;
        const redraw_cursor_linepos = line.locate_cursor(redraw_lineidx);
        this.#do_cursor_down(redraw_cursor_linepos[0] - this.#cursor.subline);
        this.#do_cursor_right(redraw_cursor_linepos[1] - this.#cursor.pos[1]);
        if (old_nsublines !== new_nsublines && (deleted || !last_line))
            this.#do_clear_end_of_screen();
        this.#write(line.draw_text(redraw_lineidx));
        if (old_nsublines === new_nsublines && deleted)
            this.#do_kill_line();
        const line_offset = this.#cursor.pos[0] - this.#cursor.subline;
        const new_cursor_linepos = line.locate_cursor(cursor_lineidx);
        this.#cursor.lineidx = cursor_lineidx;
        this.#cursor.subline = new_cursor_linepos[0];
        this.#cursor.pos[0] = this.#cursor.subline + line_offset;
        this.#cursor.pos[1] = new_cursor_linepos[1];
        if (old_nsublines === new_nsublines || last_line) {
            const cur_cursor_linepos = line.locate_cursor(line.text.length);
            this.#do_cursor_down(new_cursor_linepos[0] - cur_cursor_linepos[0]);
            this.#do_cursor_right(new_cursor_linepos[1] - cur_cursor_linepos[1]);
            return;
        }
        this.#do_cursor_start_of_nextline();
        this.#redraw_lines(this.#cursor.line + 1);
    }
    #rewrap_lines(rewrap_range, redraw_range, line_changed) {
        // lines within rewrap_range will be rewrapped.
        // lines that are rewrapped, ones after the first line where the start line changed,
        // and ones within the redraw range will be redrawn.
        const ninput_lines = this.#lines.length;
        if (rewrap_range === undefined)
            rewrap_range = [0, ninput_lines];
        if (redraw_range === undefined)
            redraw_range = [ninput_lines, ninput_lines];
        const [rewrap_start, rewrap_end] = rewrap_range;
        let [redraw_start, redraw_end] = redraw_range;
        let redraw_set = new Set();
        for (let lineno = rewrap_start; lineno < rewrap_end; lineno++) {
            const line = this.#lines[lineno];
            const old_nlines = line.nsublines;
            const changed = line.rewrap(this.#columns);
            if (redraw_start <= lineno && redraw_end >= ninput_lines)
                continue;
            const new_nlines = line.nsublines;
            if (old_nlines !== new_nlines) {
                redraw_start = lineno;
                redraw_end = ninput_lines;
                continue;
            }
            if (changed) {
                redraw_set.add(lineno);
            }
        }

        let clear_at = ninput_lines;
        if (redraw_end < ninput_lines) {
            for (let lineno = redraw_start; lineno < redraw_end; lineno++)
                redraw_set.add(lineno);
            for (let lineno = ninput_lines - 1; lineno >= 0; lineno--) {
                if (!redraw_set.has(lineno))
                    break;
                redraw_set.delete(lineno);
                clear_at = lineno;
            }
        }
        else {
            clear_at = redraw_start;
            for (let lineno = ninput_lines - 1; lineno >= redraw_start; lineno--)
                redraw_set.delete(lineno);
            for (let lineno = redraw_start - 1; lineno >= 0; lineno--) {
                if (!redraw_set.has(lineno))
                    break;
                redraw_set.delete(lineno);
                clear_at = lineno;
            }
        }
        if (redraw_set.size === 0 && clear_at === ninput_lines && !line_changed)
            return;

        // Redraw individual lines
        let cursor_set = false;
        let skipped_lines = 0;
        const move_cursor = (lineno) => {
            if (cursor_set) {
                this.#do_cursor_down(skipped_lines);
                skipped_lines = 0;
            }
            else {
                // Assume cursor row is correct.
                this.#do_cursor_start_of_line();
                this.#do_cursor_down(this.#count_lines(0, lineno) - this.#cursor.pos[0]);
                cursor_set = true;
            }
        };
        for (let lineno = 0; lineno < clear_at; lineno++) {
            const line = this.#lines[lineno];
            if (!redraw_set.has(lineno)) {
                skipped_lines += line.nsublines;
                continue;
            }
            move_cursor(lineno);
            this.#write(line.draw_text(0));
            this.#do_kill_line();
            this.#do_cursor_start_of_nextline();
        }
        move_cursor(clear_at);
        // Trust `this.#cursor.line` and `this.#cursor.lineidx`,
        // recompute `this.#cursor.subline` and `this.#cursor.pos`
        const cursor_line = this.#lines[this.#cursor.line];
        const cursor_linepos = cursor_line.locate_cursor(this.#cursor.lineidx);
        const line_offset = this.#count_lines(0, this.#cursor.line);
        this.#cursor.subline = cursor_linepos[0];
        this.#cursor.pos[0] = this.#cursor.subline + line_offset;
        this.#cursor.pos[1] = cursor_linepos[1];
        // #redraw_lines will also set the cursor for us
        this.#redraw_lines(clear_at);
    }

    // API
    async #print() {
        // Clear prompt
        this.#do_cursor_start_of_line();
        this.#do_cursor_up(this.#count_lines(0, this.#cursor.line) + this.#cursor.subline);
        this.#do_clear_end_of_screen();
        if (this.#print_col > 0) {
            this.#do_cursor_up();
            this.#do_cursor_right(this.#print_col);
        }
        const data = this.#print_string.replaceAll(/\r\n/g, '\n').replaceAll(/[\r\n]/g, '\r\n');
        this.#print_string = '';
        this.#write(data);
        // Save cursor
        const cursor_col = this.#get_cursor_col();
        // Clear screen and move to prompt start
        // Clear till end of screen, this more or less matches zsh's behavior.
        this.#do_clear_end_of_screen();
        this.#print_col = await cursor_col;
        if (this.#print_col !== 0)
            this.#do_cursor_start_of_nextline();
        this.#redraw_lines(0);
    }
    async #print_worker() {
        try {
            while (this.#print_string.length > 0){
                await this.#print();
            }
        }
        finally {
            this.#print_worker_running = false;
        }
    }
    #print_worker_running
    #print_string = ''
    print(data) {
        // Terminal inactive, ignore.
        if (this.#lines.length == 0)
            return;
        this.#print_string += data;
        if (!this.#print_worker_running) {
            this.#print_worker_running = true;
            this.#print_worker();
        }
    }
}
