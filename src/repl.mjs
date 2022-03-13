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

function wrap_line(text, start_idx, column, lw = []) {
    let line_len = 0;
    const length = text.length;
    for (let idx = start_idx; idx < length;) {
        const [disp_len, idx_len] = unicode.getLengthAt(text, idx);
        if (line_len + disp_len > column) {
            lw.push(idx);
            line_len = 0;
        }
        line_len += disp_len;
        idx += idx_len;
    }
    return line_len;
}

class Line {
    text = ''
    #sublinewrap = []
    start
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
        const line_len = wrap_line(this.text, idx, column, lw);
        if (line_len == column) // Empty line if the last line is full
            lw.push(this.text.length);
        const changed = array_equal(this.#sublinewrap, lw);
        this.#sublinewrap = lw;
        return changed;
    }
    has_force_wrap() {
        return this.#sublinewrap.length > 0 &&
               this.#sublinewrap[this.#sublinewrap.length - 1] === this.text.length;
    }
    // The output to draw the text in this line from `start_idx`
    draw_text(start_idx, force_kill) {
        const text = this.text.substring(start_idx);
        if (this.has_force_wrap())
            return text + ' \r\x1b[K'; // Force wrap line
        return text + (force_kill ? '\x1b[K' : '');
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
            const mid = (lo + hi + 1) >> 1;
            const line_start = lw[mid];
            if (idx == line_start) {
                return [mid + 1, line_start];
            }
            else if (idx > line_start) {
                lo = mid;
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
        const line_start = line == 0 ? 0 : this.#sublinewrap[line - 1];
        const line_end = (line >= this.#sublinewrap.length - 1 ? text.length :
                          this.#sublinewrap[line]);
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
    onAbort
    #onAbort

    #prompt_cb
    #ps_len
    #ps0
    #ps1

    #columns
    #rows
    #display_row_range = [0, 0] // start is inclusive, end is not inclusive.
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
        this.#onAbort = new vscode.EventEmitter();
        this.onAbort = this.#onAbort.event;
        this.#cursor = new Cursor();
    }

    // vscode interface
    open(dims) {
        this.#columns = dims.columns;
        this.#rows = dims.rows;
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
        else if (data === '\x03') {
            if (this.#lines.length > 1 || this.#lines[0].text != this.#ps0) {
                this.#cursor_to_start();
                this.#do_clear_end_of_screen();
                this.#new_prompt();
                return;
            }
            this.#write('^C');
            this.#do_cursor_start_of_nextline();
            this.#do_clear_end_of_screen();
            this.#new_prompt();
            this.#onAbort.fire();
            return;
        }
        this.#input_text(data);
    }
    setDimensions(dims) {
        if (this.#columns === dims.columns && this.#rows === dims.rows)
            return;
        this.#queue_write();
        const ninput_lines = this.#lines.length;
        const had_screen_ub = this.#display_row_range[1] > 0;
        const origin_screen_ub = had_screen_ub ? this.#display_row_range[1] :
                                 this.#start_line(ninput_lines);
        const origin_nrows = origin_screen_ub - this.#display_row_range[0];
        if (this.#columns !== dims.columns) {
            this.#columns = dims.columns;
            this.#rows = dims.rows;
            // I was not able to find any good reference stating what should happen
            // to the on-screen text when line wrapping for any line
            // visible on the screen changed. In fact, konsole and xterm.js
            // seems to behave somewhat differently in this regard
            // (and zsh seems to work better with the konsole behavior).
            // Because of this, we'll redraw the whole repl display when the width changed.

            // AFAICT, it is impossible to access/change the text on screen outside of
            // the bottom one screen space so if some text were pushed
            // to outside of the screen due to line wrapping change,
            // it's impossible to change them to what we want at that time.
            // This means that unless resizing the terminal
            // causes the output to change exactly the way we want them to change
            // (which is not the case) we are bound to, in some cases, have
            // garbage output outside the visible range of the screen.
            // All REPL's I've seen do this...

            // Fortunately since we are targetting specifically xterm.js
            // in vscode, we don't have to deal with the difference between terminals
            // (though xterm.js doesn't seem to handle everything as nice as I'd like either)
            // so we can create our output based on my best understanding of xterm.js behavior.
            // However, the behavior doesn't seem to be exactly consistent
            // and depends on if the display was overflown which is difficult to know...
            // With that, this is the observed behavior of xterm.js when the width changes.

            // * If the display is already overflown
            //   * The cursor is kept at the same location on-screen unless being pushed
            //     to the left by the resize
            //   * From the last line on screen up, each line of text
            //     (as in output text without line break in them)
            //     will be rewrapped for the new screen width.
            //   * Unless the cursor is on the line
            //     (after the later lines have been rewrapped
            //     so it may or may not be the same line)
            //     in which case the line is truncated and not wrapped
            // * If the display isn't wrapped
            //   * The same process is used to rewrap the lines.
            //   * However, the cursor line is pushed down by the rewrapped lines before it
            //     until it reaches the last line. Lines after the cursor that doesn't fit
            //     will not be drawn.
            // * Note that unlike konsole, the empty line at the end of a wrapped line
            //   (generated using zsh's force rewrap trick) counts as a second line in xterm.js
            //   and will be individually wrapped.

            // From this rule, when the display is already overflown
            // and when the width is increased, the cursor could be moved up
            // relative to the REPL and may actually end up above the REPL.
            // Since we don't really want to track those lines,
            // we won't really know how much we need to move the cursor down by...
            // In those case we'll simply redraw the REPL on the line after the cursor.

            const rewrapped = new Set();
            const last_screen_lineno =
                had_screen_ub ? this.#find_containing_line(this.#display_row_range[1] - 1) :
                (this.#lines.length - 1);
            const first_screen_lineno =
                this.#find_containing_line(this.#display_row_range[0]);
            let dist_to_cursor = origin_screen_ub - this.#cursor.pos[0];
            let wrapped_nrows = 0;
            for (let lineno = last_screen_lineno; lineno >= first_screen_lineno; lineno--) {
                const line = this.#lines[lineno];
                let is_full_line = true;
                let has_extra_newline = line.has_force_wrap();
                let origin_nsublines = line.nsublines;
                let text = line.text;
                if (lineno === last_screen_lineno &&
                    line.start + line.nsublines < origin_screen_ub) {
                    is_full_line = false;
                    if (has_extra_newline)
                        has_extra_newline = false;
                    origin_nsublines = origin_screen_ub - line.start;
                    text = text.substring(0, line.subline_start(origin_nsublines));
                }
                if (lineno === first_screen_lineno && line.start < this.#display_row_range[0]) {
                    is_full_line = false;
                    const start_subline = this.#display_row_range[0] - line.start;
                    origin_nsublines -= start_subline;
                    text = text.substring(line.subline_start(start_subline));
                }
                line.rewrap(this.#columns);
                rewrapped.add(lineno);
                if (has_extra_newline) {
                    dist_to_cursor -= 1;
                    origin_nsublines -= 1;
                }
                if (dist_to_cursor > 0 && dist_to_cursor <= origin_nsublines) {
                    // This is the new cursor line and isn't wrapped.
                    dist_to_cursor -= origin_nsublines;
                    wrapped_nrows += is_full_line ? line.nsublines :
                                     (wrap_line(text, 0, this.#columns).length + 1);
                    continue;
                }
                if (is_full_line) {
                    dist_to_cursor -= line.nsublines;
                    wrapped_nrows += line.nsublines;
                    if (line.has_force_wrap()) {
                        dist_to_cursor += 1;
                    }
                }
                else {
                    const new_nsublines = wrap_line(text, 0, this.#columns).length + 1;
                    dist_to_cursor -= new_nsublines;
                    wrapped_nrows += new_nsublines;
                }
            }
            // `-dist_to_cursor` is now the number of lines we need to move up
            // to reach the start of the REPL.
            if (dist_to_cursor > 0) {
                // Don't move down if we haven't found the cursor yet since we don't actually
                // know what's in between...
                this.#do_cursor_start_of_nextline();
            }
            else {
                this.#do_cursor_start_of_line();
                this.#do_cursor_up(-dist_to_cursor);
            }

            let start_line = 0;
            for (let lineno = 0; lineno < ninput_lines; lineno++) {
                const line = this.#lines[lineno];
                line.start = start_line;
                if (!rewrapped.has(lineno))
                    line.rewrap(this.#columns);
                start_line += line.nsublines;
            }

            // Now the lines and cursor are all set, we need to set the display range again.
            const new_row_limit = Math.min(this.#rows,
                                           Math.max(this.#rows - 1, wrapped_nrows,
                                                    origin_nrows));
            const new_total_nrows = this.#start_line(ninput_lines);
            const has_row_limit = new_total_nrows > new_row_limit;
            const new_nrows = has_row_limit ? new_row_limit : new_total_nrows;
            if (!has_row_limit) {
                this.#display_row_range = [0, 0];
                this.#recompute_cursor();
            }
            else {
                const origin_cursor_screenpos = this.#cursor.pos[0] - this.#display_row_range[0];
                const cursor_screenpos = Math.min(origin_cursor_screenpos, new_nrows - 1);
                this.#recompute_cursor();
                this.#display_row_range[0] = this.#cursor.pos[0] - cursor_screenpos;
                this.#display_row_range[1] = this.#display_row_range[0] + new_nrows;
            }
        }
        else {
            const origin_cursor_screenpos = this.#cursor.pos[0] - this.#display_row_range[0];
            this.#do_cursor_start_of_line();
            this.#do_cursor_up(origin_cursor_screenpos);

            this.#rows = dims.rows;

            const new_row_limit = Math.min(this.#rows, Math.max(this.#rows - 1, origin_nrows));
            const new_total_nrows = this.#start_line(ninput_lines);
            const has_row_limit = new_total_nrows > new_row_limit;
            const new_nrows = has_row_limit ? new_row_limit : new_total_nrows;
            if (!has_row_limit) {
                this.#display_row_range = [0, 0];
            }
            else {
                const cursor_screenpos = Math.min(origin_cursor_screenpos, new_nrows - 1);
                this.#display_row_range[0] = this.#cursor.pos[0] - cursor_screenpos;
                this.#display_row_range[1] = this.#display_row_range[0] + new_nrows;
            }
        }
        this.#do_clear_end_of_screen();
        this.#move_cursor_rel(this.#redraw_range(), this.#cursor.pos);
    }

    // Basic terminal write and control sequence functions
    #write_queued = false
    #write_buffer = ''
    #write(data) {
        if (data.length === 0)
            return;
        if (this.#write_queued) {
            this.#write_buffer += data;
            return;
        }
        this.#onDidWrite.fire(data);
    }
    #queue_write() {
        if (this.#write_queued)
            return;
        this.#write_queued = true;
        // vscode doesn't sequence the terminal IO correctly wrt resize event
        // which causes writes emitted inside `setDimensions` to be calculated
        // using the old terminal size.
        // A simple wait-for-next event (i.e. setTimeout(..., 0)) doesn't seem to work either
        // and neither does a timeout of ~10ms. A timeout of 100ms seems
        // to work OK on my computer.
        // This makes it a bit racy for repetitive resize events
        // but this is the best we can do for now.
        // (FWIW, real terminal applications have the same race condition
        //  but in principle we should be able to do better...
        //  at least it's not the only limitation we need to work with
        //  and not even the most important one since resize is hopefully
        //  not going to happen very frequently....)
        setTimeout(() => {
            this.#write_queued = false;
            const buffer = this.#write_buffer;
            this.#write_buffer = '';
            this.#write(buffer);
        }, 150);
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

    // Cursor utilities
    #move_cursor_rel(from_pos, to_pos) {
        if (to_pos[1] == 0 && from_pos[1] != 0) {
            this.#do_cursor_start_of_line();
        }
        else {
            this.#do_cursor_right(to_pos[1] - from_pos[1]);
        }
        this.#do_cursor_down(to_pos[0] - from_pos[0]);
    }
    #cursor_to_start() {
        // Only works if the screen isn't resized
        // This should only read this.#cursor.pos
        this.#move_cursor_rel(this.#cursor.pos, [this.#display_row_range[0], 0]);
    }
    #shift_and_set_cursor(prev_cursor) {
        if (this.#display_row_range[0] !== 0 &&
            this.#cursor.pos[0] < this.#display_row_range[0]) {
            const new_lb = this.#cursor.pos[0];
            const new_ub = new_lb + this.#display_row_range[1] - this.#display_row_range[0];
            this.#move_cursor_rel(prev_cursor, [this.#display_row_range[0], 0]);
            this.#do_clear_end_of_screen();
            this.#display_row_range[0] = new_lb;
            this.#display_row_range[1] = new_ub;
            this.#move_cursor_rel(this.#redraw_range(), this.#cursor.pos);
        }
        else if (this.#display_row_range[1] !== 0 &&
                 this.#cursor.pos[0] >= this.#display_row_range[1]) {
            const new_ub = this.#cursor.pos[0] + 1;
            const new_lb = Math.max(new_ub - this.#rows, this.#display_row_range[0]);
            this.#move_cursor_rel(prev_cursor, [this.#display_row_range[0], 0]);
            this.#do_clear_end_of_screen();
            this.#display_row_range[0] = new_lb;
            this.#display_row_range[1] = new_ub;
            this.#move_cursor_rel(this.#redraw_range(), this.#cursor.pos);
        }
        else {
            this.#move_cursor_rel(prev_cursor, this.#cursor.pos);
        }
    }
    #recompute_cursor() {
        // Trust `this.#cursor.line` and `this.#cursor.lineidx`,
        // recompute `this.#cursor.subline` and `this.#cursor.pos`
        const cursor_line = this.#lines[this.#cursor.line];
        const cursor_linepos = cursor_line.locate_cursor(this.#cursor.lineidx);
        const line_offset = this.#start_line(this.#cursor.line);
        this.#cursor.subline = cursor_linepos[0];
        this.#cursor.pos[0] = this.#cursor.subline + line_offset;
        this.#cursor.pos[1] = cursor_linepos[1];
    }

    // Other utility functions
    #find_containing_line(sublineno) {
        let lo = 0;
        let hi = this.#lines.length - 1;
        // Find the last line index that starts no greater than sublineno
        while (hi > lo) {
            const mid = (lo + hi + 1) >> 1;
            const line = this.#lines[mid];
            const line_start = line.start;
            if (sublineno == line_start) {
                return mid;
            }
            else if (sublineno > line_start) {
                lo = mid;
            }
            else {
                hi = mid - 1;
            }
        }
        return lo;
    }
    #start_line(lineno) {
        const ninput_lines = this.#lines.length;
        if (lineno < ninput_lines)
            return this.#lines[lineno].start;
        const line = this.#lines[ninput_lines - 1];
        return line.start + line.nsublines;
    }
    #count_lines(start, end) {
        return this.#start_line(end) - this.#start_line(start);
    }

    // Text/line drawing functions
    #redraw_range(draw_start, draw_end, clear_line_end) {
        // Draw the lines within the display rows.
        // Assume that the cursor is moved to where we should start drawing already.
        // Assume that the screen range to draw is cleared unless `clear_line_end` is true.
        // Assume that all the lines are properly wrapped.
        const ninput_lines = this.#lines.length;
        let first_lineno;
        let start_lineidx;
        if (draw_start === undefined) {
            first_lineno = this.#find_containing_line(this.#display_row_range[0]);
            const line = this.#lines[first_lineno];
            const start_subline = this.#display_row_range[0] - line.start;
            start_lineidx = line.subline_start(start_subline);
        }
        else {
            [first_lineno, start_lineidx] = draw_start;
        }
        let end_disp_lineno = draw_end || this.#display_row_range[1] ||
                              this.#start_line(ninput_lines);
        for (let lineno = first_lineno; ; lineno++) {
            const line = this.#lines[lineno];
            let until_end = end_disp_lineno - line.start;
            const endline = line.start + line.nsublines;
            if (until_end <= line.nsublines || lineno >= ninput_lines - 1) {
                // the current line include the lastline,
                // make sure we don't output more than we need
                // and in particular don't output the force line wrap unless necessary.

                // Note that we need to check the last line number rather than the last line idx.
                // The last and second to last line has the same ending lineidx
                // if the last line is empty.
                if (until_end >= line.nsublines) {
                    this.#write(line.draw_text(start_lineidx, clear_line_end));
                    // In case we didn't set the display range well
                    // and we actually finished the last line before we hit the limit
                    // adjust the line counter so that we can return an accurate position below.
                    end_disp_lineno -= until_end - line.nsublines;
                    until_end = line.nsublines;
                }
                else {
                    const draw_text = line.text.substring(start_lineidx,
                                                          line.subline_start(until_end));
                    this.#write(draw_text + (clear_line_end ? '\x1b[K' : ''));
                }
                // If the cursor is at the end of row, the cursor position is actually
                // `column - 1` (i.e. outputting the last character didn't move it).
                return [end_disp_lineno - 1, Math.min(line.subline_width(until_end - 1),
                                                      this.#columns - 1)];
            }
            this.#write(line.draw_text(start_lineidx) + (clear_line_end ? '\x1b[K' : ''));
            this.#do_cursor_start_of_nextline();
            start_lineidx = 0;
        }
    }

    // Terminal function with buffer management
    #cursor_right() {
        const line = this.#lines[this.#cursor.line];
        const linemove = line.cursor_right(this.#cursor.subline, this.#cursor.lineidx);
        if (linemove[0] === CursorMoveType.SameLine) {
            // Still not at the end, simply move forward
            this.#do_cursor_right(linemove[1]);
            this.#cursor.lineidx += linemove[2];
            this.#cursor.pos[1] += linemove[1];
            return;
        }
        const prev_cursor = [...this.#cursor.pos];
        if (linemove[0] === CursorMoveType.ChangeSubline) {
            this.#cursor.lineidx += linemove[2];
            this.#cursor.subline += 1;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = 0;
        }
        else if (this.#cursor.line >= this.#lines.length - 1) {
            // Last line, nothing to do
            return;
        }
        else {
            this.#cursor.line += 1;
            this.#cursor.lineidx = 0;
            this.#cursor.subline = 0;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = 0;
        }
        this.#shift_and_set_cursor(prev_cursor);
    }
    #cursor_left() {
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
        const prev_cursor = [...this.#cursor.pos];
        if (linemove[0] === CursorMoveType.ChangeSubline) {
            this.#cursor.lineidx -= linemove[2];
            this.#cursor.subline -= 1;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = linemove[1];
        }
        else if (this.#cursor.line == 0) {
            // First line, nothing to do
            return;
        }
        else {
            // Move to the prev line
            this.#cursor.line -= 1;
            const newline = this.#lines[this.#cursor.line];
            this.#cursor.subline = newline.nsublines - 1;
            const new_col = newline.subline_width(this.#cursor.subline);
            this.#cursor.lineidx = newline.text.length;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = new_col;
        }
        this.#shift_and_set_cursor(prev_cursor);
    }
    #cursor_up() {
        let curcol = this.#cursor.pos[1];
        const prev_cursor = [...this.#cursor.pos];
        if (this.#cursor.subline > 0) {
            const line = this.#lines[this.#cursor.line];
            // Move up within the line
                this.#cursor.subline -= 1;
            if (this.#cursor.subline == 0 && curcol < this.#ps_len)
                curcol = this.#ps_len;
            const [newidx, newpos] = line.find_index(this.#cursor.subline, curcol);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = newpos;
        }
        else if (this.#cursor.line == 0) {
            // First line already, move to start of line
            // TODO history
            return this.#cursor_begin_of_line();
        }
        else {
            // Move to previous line
            this.#cursor.line -= 1;
            const line = this.#lines[this.#cursor.line];
            this.#cursor.subline = line.nsublines - 1;
            if (this.#cursor.subline == 0 && curcol < this.#ps_len)
                curcol = this.#ps_len;
            const [newidx, newpos] = line.find_index(line.nsublines - 1, curcol);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] -= 1;
            this.#cursor.pos[1] = newpos;
        }
        this.#shift_and_set_cursor(prev_cursor);
    }
    #cursor_down() {
        const line = this.#lines[this.#cursor.line];
        const prev_cursor = [...this.#cursor.pos];
        if (this.#cursor.subline < line.nsublines - 1) {
            // Move down within the line
            this.#cursor.subline += 1;
            const [newidx, newpos] = line.find_index(this.#cursor.subline,
                                                     this.#cursor.pos[1]);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = newpos;
        }
        else if (this.#cursor.line >= this.#lines.length - 1) {
            // Last line already, move to end of line
            // TODO history
            return this.#cursor_end_of_line();
        }
        else {
            // Move to next line
            this.#cursor.line += 1;
            const newline = this.#lines[this.#cursor.line];
            this.#cursor.subline = 0;
            let curcol = this.#cursor.pos[1];
            if (curcol < this.#ps_len)
                curcol = this.#ps_len;
            const [newidx, newpos] = newline.find_index(0, curcol);
            this.#cursor.lineidx = newidx;
            this.#cursor.pos[0] += 1;
            this.#cursor.pos[1] = newpos;
        }
        this.#shift_and_set_cursor(prev_cursor);
    }
    #cursor_begin_of_line() {
        const line = this.#lines[this.#cursor.line];
        const prefix_idxlen = this.#cursor.line == 0 ? this.#ps0.length : this.#ps1.length;
        const prev_cursor = [...this.#cursor.pos];
        this.#cursor.lineidx = prefix_idxlen;
        this.#cursor.pos[0] -= this.#cursor.subline;
        this.#cursor.pos[1] = this.#ps_len;
        this.#cursor.subline = 0;
        this.#shift_and_set_cursor(prev_cursor);
    }
    #cursor_end_of_line() {
        const line = this.#lines[this.#cursor.line];
        const width = line.subline_width(line.nsublines - 1);
        const ndown = line.nsublines - this.#cursor.subline - 1;
        const prev_cursor = [...this.#cursor.pos];
        this.#cursor.lineidx = line.text.length;
        this.#cursor.subline = line.nsublines - 1;
        this.#cursor.pos[0] += ndown;
        this.#cursor.pos[1] = width;
        this.#shift_and_set_cursor(prev_cursor);
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
                               [this.#cursor.line, this.#lines.length]);
            return;
        }
        const curline_suffix = curline.text.substring(redraw_lineidx + 1);
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        if (unicode.isLowSurrogate(curline.text.charCodeAt(redraw_lineidx)) &&
            redraw_lineidx - 1 >= prefix_idxlen)
            redraw_lineidx -= 1;
        curline.text = curline_prefix + curline_suffix;
        this.#cursor.lineidx -= 1;
        this.#redraw_cursor_line(redraw_lineidx, true);
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
                           [this.#cursor.line, this.#lines.length]);
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
        this.#redraw_cursor_line(redraw_lineidx, true);
    }
    #kill_line() {
        const curline = this.#lines[this.#cursor.line];
        const redraw_lineidx = this.#cursor.lineidx;
        const curline_prefix = curline.text.substring(0, redraw_lineidx);
        // Delete end of line
        if (redraw_lineidx >= curline.text.length)
            return this.#delete_newline();
        curline.text = curline_prefix;
        this.#redraw_cursor_line(redraw_lineidx, true);
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
            return this.#new_line();
        if (this.#display_row_range[1] > 0) {
            this.#cursor_to_start();
            this.#do_clear_end_of_screen();
            this.#write(text);
        }
        else {
            this.#do_cursor_down(this.#count_lines(this.#cursor.line, ninput_lines) -
                                 this.#cursor.subline - 1);
        }
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
            this.#cursor.lineidx = redraw_lineidx + new_text.length;
            curline.text = curline_prefix + new_text + curline_suffix;
            this.#redraw_cursor_line(redraw_lineidx);
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
            this.#rewrap_lines(range, range);
        }
    }
    #new_prompt() {
        // Assume that `this.#cursor.pos[0]` is set already.
        this.#lines = [new Line(this.#ps0)];
        this.#print_col = 0;
        this.#cursor.line = 0;
        this.#cursor.lineidx = this.#ps0.length;
        this.#display_row_range = [0, 0];
        this.#rewrap_lines([0, 1], [0, 1]);
    }

    // Terminal utility functions
    #recompute_startline(first) {
        const prev_line = this.#lines[first - 1];
        const ninput_lines = this.#lines.length;
        let start_line = prev_line.start + prev_line.nsublines;
        for (let lineno = first; lineno < ninput_lines; lineno++) {
            const line = this.#lines[lineno];
            line.start = start_line;
            start_line += line.nsublines;
        }
    }
    #check_display_range_change() {
        const ninput_lines = this.#lines.length;
        const prev_cursor = [...this.#cursor.pos];
        const prev_repl_start = [this.#display_row_range[0], 0];

        // First check if the drawing range is still good
        // If not, set a good range and do a full redraw.
        // Otherwise do a partial redraw if possible.
        this.#recompute_cursor();
        const had_screen_ub = this.#display_row_range[1] > 0;
        const new_total_nrows = this.#start_line(ninput_lines);
        let display_range_changed = false;
        if (this.#display_row_range[1] > new_total_nrows) {
            display_range_changed = true;
            const prev_display_rows = this.#display_row_range[1] - this.#display_row_range[0];
            this.#display_row_range = [Math.max(new_total_nrows - prev_display_rows, 0),
                                       new_total_nrows];
        }
        if (this.#cursor.pos[0] < this.#display_row_range[0]) {
            this.#display_row_range[0] = this.#cursor.pos[0];
            display_range_changed = true;
        }
        else if (had_screen_ub && this.#cursor.pos[0] >= this.#display_row_range[1]) {
            this.#display_row_range[1] = this.#cursor.pos[0] + 1;
            display_range_changed = true;
        }
        if (had_screen_ub) {
            if (this.#display_row_range[1] - this.#display_row_range[0] > this.#rows) {
                // This means that the cursor movement above pushed the display range
                // to be larger than screen.
                display_range_changed = true;
                this.#display_row_range[0] = Math.min(this.#cursor.pos[0],
                                                      this.#display_row_range[1] - this.#rows);
                this.#display_row_range[1] = this.#display_row_range[0] + this.#rows;
            }
            else if (new_total_nrows <= this.#display_row_range[1] - this.#display_row_range[0]) {
                this.#display_row_range = [0, 0];
                display_range_changed = true;
            }
        }
        else if (new_total_nrows > this.#rows) {
            this.#display_row_range[1] = Math.max(this.#rows, this.#cursor.pos[0] + 1);
            this.#display_row_range[0] = this.#display_row_range[1] - this.#rows;
            display_range_changed = true;
        }
        if (this.#display_row_range[1] === new_total_nrows && this.#display_row_range[0] === 0)
            display_range_changed = true;
        if (!display_range_changed)
            return false
        this.#move_cursor_rel(prev_cursor, prev_repl_start);
        this.#do_clear_end_of_screen();
        this.#move_cursor_rel(this.#redraw_range(), this.#cursor.pos);
        return true;
    }
    #move_to_drawing_start(prev_cursor, lineno, redraw_lineidx, pos) {
        const line = this.#lines[lineno];
        const line_start = line.start;
        if (this.#display_row_range[0] > line_start) {
            // There's a chance that the redraw lineidx is not on screen.
            // In such case, forward the redraw index to be
            // at the beginning of the visible screen.
            const visible_lineidx =
                line.find_index(this.#display_row_range[0] - line_start, 0)[0];
            if (visible_lineidx > redraw_lineidx) {
                this.#move_cursor_rel(prev_cursor, [this.#display_row_range[0], 0]);
                return [lineno, visible_lineidx];
            }
        }
        const subpos = line.locate_cursor(redraw_lineidx);
        this.#move_cursor_rel(prev_cursor, [line_start + subpos[0], subpos[1]]);
        return [lineno, redraw_lineidx];
    }
    #rewrap_lines(rewrap_range, redraw_range) {
        // lines within rewrap_range will be rewrapped.
        // lines that are rewrapped, ones after the first line where the start line changed,
        // and ones within the redraw range will be redrawn.
        const ninput_lines = this.#lines.length;
        const [rewrap_start, rewrap_end] = rewrap_range;
        let [redraw_start, redraw_end] = redraw_range;
        let linestart_changed = false;
        let start_line = this.#lines[rewrap_start].start;
        if (start_line === undefined) {
            if (rewrap_start === 0) {
                start_line = 0;
            }
            else {
                const prev_line = this.#lines[rewrap_start - 1];
                start_line = prev_line.start + prev_line.nsublines;
            }
        }
        for (let lineno = rewrap_start; lineno < rewrap_end; lineno++) {
            const line = this.#lines[lineno];
            if (line.start !== start_line) {
                line.start = start_line;
                redraw_end = ninput_lines;
            }
            const old_nlines = line.nsublines;
            const changed = line.rewrap(this.#columns);
            const new_nlines = line.nsublines;
            start_line += new_nlines;
            if (redraw_start <= lineno && redraw_end >= ninput_lines)
                continue;
            if (old_nlines !== new_nlines) {
                redraw_start = lineno;
                redraw_end = ninput_lines;
                continue;
            }
            if (changed) {
                redraw_start = Math.min(redraw_start, lineno);
                redraw_end = Math.max(redraw_end, lineno + 1);
            }
        }
        if (rewrap_end < ninput_lines) {
            const nextline = this.#lines[rewrap_end];
            if (nextline.start !== start_line) {
                redraw_end = ninput_lines;
                this.#recompute_startline(rewrap_end);
            }
        }

        const prev_cursor = [...this.#cursor.pos];
        if (this.#check_display_range_change())
            return;

        const had_screen_ub = this.#display_row_range[1] > 0;
        // Redraw within [redraw_start, redraw_end)
        const draw_start = this.#move_to_drawing_start(prev_cursor, redraw_start, 0);
        const do_redraw = (end) => {
            const full_redraw = end === undefined;
            if (full_redraw)
                this.#do_clear_end_of_screen();
            this.#move_cursor_rel(this.#redraw_range(draw_start, end, !full_redraw),
                                  this.#cursor.pos);
        };
        if (redraw_end >= ninput_lines)
            return do_redraw();
        const end_redraw_subline = this.#start_line(redraw_end);
        if (!had_screen_ub)
            return do_redraw(end_redraw_subline);
        if (end_redraw_subline >= this.#display_row_range[1])
            return do_redraw();
        return do_redraw(end_redraw_subline);
    }
    #redraw_cursor_line(redraw_lineidx, deleted) {
        // Assume cursor is at `this.#cursor.pos` and `this.#cursor.subline`
        // and assume everything about the line hasn't change before `redraw_lineidx`.
        // Rewrap and redraw the cursor line (from redraw_lineidx)

        // If the number of lines is changed after wrapping,
        // the lines following the cursor line will be redrawn.

        // The cursor will be repositioned using this.#cursor.lineidx.

        // This is essentially a specialized version of #rewrap_lines
        // when there's only changes on a single line.

        const ninput_lines = this.#lines.length;
        const line = this.#lines[this.#cursor.line];
        const last_line = this.#cursor.line === this.#lines.length - 1;
        const old_nsublines = line.nsublines;
        line.rewrap(this.#columns, redraw_lineidx);
        const new_nsublines = line.nsublines;
        if (old_nsublines !== new_nsublines)
            this.#recompute_startline(this.#cursor.line + 1);

        const prev_cursor = [...this.#cursor.pos];
        if (this.#check_display_range_change())
            return;

        const had_screen_ub = this.#display_row_range[1] > 0;
        const draw_start = this.#move_to_drawing_start(prev_cursor, this.#cursor.line,
                                                       redraw_lineidx);
        const do_redraw = (end) => {
            const full_redraw = end === undefined;
            if (full_redraw && deleted)
                this.#do_clear_end_of_screen();
            this.#move_cursor_rel(this.#redraw_range(draw_start, end,
                                                     !full_redraw && deleted),
                                  this.#cursor.pos);
        };
        if (this.#cursor.line >= ninput_lines - 1 || old_nsublines !== new_nsublines)
            return do_redraw();
        const end_redraw_subline = line.start + new_nsublines;
        if (!had_screen_ub)
            return do_redraw(end_redraw_subline);
        if (end_redraw_subline >= this.#display_row_range[1])
            return do_redraw();
        return do_redraw(end_redraw_subline);
    }

    // API
    async #print() {
        // Clear prompt
        this.#do_cursor_start_of_line();
        this.#do_cursor_up(this.#start_line(this.#cursor.line) + this.#cursor.subline);
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
        if (this.#display_row_range[1] - this.#display_row_range[0] >= this.#rows) {
            // We got some output, shrink the draw range to `nrows - 1`
            // if it was larger than this...
            const new_nrows = this.#rows - 1;
            const origin_cursor_screenpos = this.#cursor.pos[0] - this.#display_row_range[0];
            const cursor_screenpos = Math.min(origin_cursor_screenpos, new_nrows - 1);
            this.#display_row_range[0] = this.#cursor.pos[0] - cursor_screenpos;
            this.#display_row_range[1] = this.#display_row_range[1] + new_nrows;
        }
        this.#move_cursor_rel(this.#redraw_range(), this.#cursor.pos);
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
