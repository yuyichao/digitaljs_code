//

'use strict';

import $ from 'jquery';
import { Vector3vl, Display3vlWithRegex, Display3vl } from '3vl';

const vscode = acquireVsCodeApi();

const controlCodes20 = [
    'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
    'BS',  'HT',  'LF',  'VT',  'FF',  'CR',  'SO',  'SI',
    'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
    'CAN', 'EM',  'SUB', 'ESC', 'FS',  'GS',  'RS',  'US',
    'SP',  'DEL'];

// Copied from digitaljs since it wasn't exported.
class Display3vlASCII extends Display3vlWithRegex {
    constructor() {
        super('[\x20-\x7e\xa0-\xff\ufffd\u2400-\u2421]|' + controlCodes20.join('|'))
    }
    get name() {
        return "ascii";
    }
    get sort() {
        return 1;
    }
    can(kind, bits) {
        return bits == 7 || bits == 8;
    }
    read(data, bits) {
        if (data.length == 1) {
            const code = data.charCodeAt(0);
            if (code == 0xfffd) return Vector3vl.xes(bits);
            if (code == 0x2421) return Vector3vl.fromHex("7f", bits);
            if (code >= 0x2400 && code <= 0x2420)
                return Vector3vl.fromHex((code - 0x2400).toString(16), bits);
            return Vector3vl.fromHex(code.toString(16), bits);
        } else {
            const code = controlCodes20.indexOf(data);
            if (code < 0) return Vector3vl.xes(bits);
            if (code == 0x21) return Vector3vl.fromHex("7f", bits);
            return Vector3vl.fromHex(code.toString(16), bits);
        }
    }
    show(data) {
        if (!data.isFullyDefined) return "\ufffd";
        const code = parseInt(data.toHex(), 16);
        if (code <= 0x20) {
            return String.fromCharCode(0x2400 + code);
        }
        if (code == 0x7f) return "\u2421";
        if (code > 0x7f && code < 0xa0) {
            return "\ufffd";
        }
        return String.fromCharCode(code);
    }
    size(bits) {
        return 1;
    }
}

class Status {
    #dp3vl
    #widgets
    #clock
    #iopanel
    #start_btn
    #pause_btn
    #fast_forward_btn
    #single_step_btn
    #next_event_btn
    constructor() {
        window.addEventListener('message', event => this.#processMessage(event));
        window.addEventListener("load", () => this.#initialize());
        this.#dp3vl = new Display3vl();
        this.#dp3vl.addDisplay(new Display3vlASCII());
        this.#widgets = {};
    }
    #initialize() {
        this.#clock = $('#clock');
        this.#iopanel = $('#iopanel');
        this.#start_btn = $('#start-sim');
        this.#pause_btn = $('#pause-sim');
        this.#fast_forward_btn = $('#fast-forward-sim');
        this.#single_step_btn = $('#single-step-sim');
        this.#next_event_btn = $('#next-event-sim');
        const btn_cmd = (btn, panel_cmd) => {
            btn.click(() => {
                vscode.postMessage({ command: 'panel-cmd', panel_cmd });
            });
        };
        btn_cmd(this.#start_btn, 'startsim');
        btn_cmd(this.#pause_btn, 'pausesim');
        btn_cmd(this.#fast_forward_btn, 'fastforwardsim');
        btn_cmd(this.#single_step_btn, 'singlestepsim');
        btn_cmd(this.#next_event_btn, 'nexteventsim');

        // Release the messages from the main extension
        vscode.postMessage({ command: 'initialized' });
        this.#updateWidgets(window.init_view);
    }
    #updateWidgets(views) {
        const old_widgets = this.#widgets;
        this.#widgets = {};
        for (const key in old_widgets)
            old_widgets[key].widget.detach();
        for (const view of views) {
            const old_w = old_widgets[view.id];
            if (old_w && old_w.dir == view.dir && old_w.bits == view.bits) {
                old_w.updater(view.value);
                this.#iopanel.append(old_w.widget);
                this.#widgets[view.id] = old_w;
                continue;
            }
            const w = this.#newWidget(view);
            this.#iopanel.append(w.widget);
            this.#widgets[view.id] = w;
        }
    }
    #newWidget(view) {
        const is_input = view.dir == 'input';
        const w = view.bits == 1 ? this.#newBitWidget(view, is_input) :
                  this.#newNumberWidget(view, is_input);
        w.dir = view.dir;
        w.bits = view.bits;
        return w;
    }
    #newBitWidget(view, is_input) {
        const id = view.id;
        const widget = $(`<tr>
  <td>
    <span class="djs-io-name" style="color:var(--foreground);vertical-align:middle;"></span>
  </td>
  <td>
    <vscode-checkbox ${is_input ? '' : 'readonly'} style="vertical-align:middle;"></vscode-checkbox>
  </td>
  <td></td>
</tr>`);
        widget.find('span.djs-io-name').text(view.label);
        const checkbox = widget.find('vscode-checkbox');
        const updater = (bin) => {
            const value = Vector3vl.fromBin(bin, 1);
            if (!is_input)
                checkbox.prop('indeterminate', !value.isDefined);
            checkbox.prop('checked', value.isHigh);
        };
        updater(view.value);
        if (is_input) {
            checkbox.change(() => {
                vscode.postMessage({ command: 'iopanel:update', id,
                                     value: checkbox.prop('checked') ? '1' : '0' });
            });
        }
        return { widget, updater };
    }
    #newNumberWidget(view, is_input) {
        const id = view.id;
        const widget = $(`<tr>
  <td>
    <span class="djs-io-name" style="color:var(--foreground);vertical-align:middle;"></span>
  </td>
  <td>
    <vscode-text-field ${is_input ? '' : 'readonly'} style="vertical-align:middle;"></vscode-text-field>
  </td>
  <td>
    <vscode-dropdown style="vertical-align: middle; min-width: 4em;">
      <vscode-option value="hex">hex</vscode-option>
      <vscode-option value="bin">bin</vscode-option>
      <vscode-option value="oct">oct</vscode-option>
      <vscode-option value="dec">dec</vscode-option>
    </vscode-dropdown>
  </td>
</tr>`);
        widget.find('span.djs-io-name').text(view.label);
        const input = widget.find('vscode-text-field');
        const base_sel = widget.find('vscode-dropdown');
        const bits = view.bits;
        let base;
        let bin = view.value;
        const updater = (new_bin) => {
            bin = new_bin;
            // Note that even if the value didn't change, the display value might.
            const value = Vector3vl.fromBin(bin, bits);
            input.val(this.#dp3vl.show(base, value));
        };
        const base_updater = (new_base) => {
            if (base === new_base)
                return;
            base = new_base;
            const sz = this.#dp3vl.size(base, bits);
            input.prop('size', sz);
            if (is_input)
                input.prop('maxlength', sz)
                     .prop('pattern', this.#dp3vl.pattern(base));
            updater(bin);
        };
        base_updater('hex');
        base_sel.change(() => {
            base_updater(base_sel.val());
        });
        if (is_input) {
            input.change((e) => {
                if (!this.#dp3vl.validate(base, e.target.value, bits))
                    return;
                const value = this.#dp3vl.read(base, e.target.value, bits);
                const new_bin = value.toBin(value);
                if (new_bin == bin)
                    return;
                bin = new_bin;
                vscode.postMessage({ command: 'iopanel:update', id, value: bin });
            });
        }
        return { widget, updater };
    }
    #processMessage(event) {
        const message = event.data;
        switch (message.command) {
            case 'tick':
                this.#clock.val(message.tick);
                return;
            case 'runstate': {
                const state = message.state;
                const ele_enabled = (ele, enable) => {
                    ele.attr('disabled', enable ? null : true);
                };
                ele_enabled(this.#start_btn, !state.running);
                ele_enabled(this.#pause_btn, state.running);
                ele_enabled(this.#fast_forward_btn, !state.running);
                ele_enabled(this.#single_step_btn, !state.running);
                ele_enabled(this.#next_event_btn, !state.running && state.pendingEvents);
                return;
            }
            case 'iopanel:view':
                this.#updateWidgets(message.view);
                return;
            case 'iopanel:update': {
                const w = this.#widgets[message.id];
                if (w)
                    w.updater(message.value);
                return;
            }
        }
    }
}

new Status();
