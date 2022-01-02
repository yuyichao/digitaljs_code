//

'use strict';

import $ from 'jquery';
import { Vector3vl, Display3vlWithRegex, Display3vl } from '3vl';

const vscode = window.acquireVsCodeApi();

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
    constructor() {
        window.addEventListener('message', event => this.processMessage(event));
        window.addEventListener("load", () => this.initialize());
        this.dp3vl = new Display3vl();
        this.dp3vl.addDisplay(new Display3vlASCII());
    }
    initialize() {
        this.clock = $('#clock');
        this.iopanel = $('#iopanel');
        // Release the messages from the main extension
        vscode.postMessage({ command: 'initialized' });
    }
    async processMessage(event) {
        const message = event.data;
        switch (message.command) {
            case 'tick':
                this.clock.val(message.tick);
                return;
        }
    }
}

new Status();
