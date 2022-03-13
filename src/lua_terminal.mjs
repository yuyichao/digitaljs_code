//

'use strict';

import REPL from './repl.mjs';
import * as luaparse from 'luaparse';

const unexpected_eof_suffix = (() => {
    // This is basically how lua.c detect parser error...
    // It would be nice if luaparse could give us a simpler ID to match...
    // It's good enough for now and I don't really want to monkey patch luaparse ATM.
    const err = luaparse.errors.unexpectedEOF;
    return err.substring(err.length - 7);
})();

class ParseResult {
    static OK = 1
    static EOF = 2
    static ERROR = 3
}

function try_parse(str) {
    try {
        luaparse.parse(str);
    }
    catch (e) {
        if (e.message && e.message.endsWith(unexpected_eof_suffix))
            return ParseResult.EOF;
        return ParseResult.ERROR;
    }
    return ParseResult.OK;
}

function try_parse_with_return(str) {
    // Do not append `;` here since we want the string to be at the end of the input.
    const res = try_parse(`return ${str}`);
    if (res === ParseResult.OK)
        return res;
    return Math.min(res, try_parse(str));
}

export class LuaTerminal extends REPL {
    #view
    #id = 0

    constructor(view) {
        super(data => this.#try_submit(data), 'lua> ', '.... ');
        this.#view = view;
        this.onAbort(() => {
            this.#view.post({
                command: 'stoplua',
                isrepl: true,
                quit: false,
            })
        });
        this.onDidDispose(() => {
            this.#view.post({
                command: 'stoplua',
                isrepl: true,
                quit: true,
            })
        });
    }

    #try_submit(data) {
        if (try_parse_with_return(data) === ParseResult.EOF)
            return false;
        this.#view.post({
            command: 'runlua',
            name: `REPL[${this.#id++}]`,
            script: data,
            isrepl: true
        });
        return true;
    }
}
