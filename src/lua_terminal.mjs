//

'use strict';

import REPL from './repl.mjs';

export class LuaTerminal extends REPL {
    #view
    #id = 0

    constructor(view) {
        super(data => this.#try_submit(data), 'lua> ', '.... ');
        this.#view = view;
    }

    #try_submit(data) {
        // TODO:
        // * automatically detect if we should take more input lines
        // * automatically print result
        // * fix scope.
        this.#view.post({
            command: 'runlua',
            name: `REPL[${this.#id++}]`,
            script: data
        });
        return true;
    }
}
