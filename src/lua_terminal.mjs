//

'use strict';

import REPL from './repl.mjs';

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
        // TODO:
        // * automatically detect if we should take more input lines
        this.#view.post({
            command: 'runlua',
            name: `REPL[${this.#id++}]`,
            script: data,
            isrepl: true
        });
        return true;
    }
}
