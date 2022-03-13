//

'use strict';

// class HistoryProvider {
//     get_latest_index() {
//     }
//     get_at_index() {
//     }
//     push() {
//     }
// }

export default class REPLHistory {
    #provider
    #latest_idx
    #index_offset = 0
    #override = []
    constructor() {
    }
    set_provider(provider) {
        this.#provider = provider;
        this.reset();
    }

    #load_provider() {
        if (this.#latest_idx !== undefined)
            return;
        this.#latest_idx = this.#provider.get_latest_index();
    }
    put_temp(input) {
        if (!this.#provider || !input)
            return;
        this.#override[this.#index_offset] = input;
    }
    put_perm(input) {
        if (!this.#provider || !input)
            return;
        this.#provider.push(input);
    }
    get_prev() {
        if (!this.#provider)
            return;
        this.#load_provider();
        const new_index = this.#index_offset + 1;
        let item = this.#override[new_index];
        if (item === undefined) {
            item = this.#provider.get_at_index(this.#latest_idx + 1 - new_index);
            if (item === undefined) {
                return;
            }
        }
        this.#index_offset = new_index;
        return item;
    }
    get_next() {
        if (!this.#provider)
            return;
        this.#load_provider();
        const new_index = this.#index_offset - 1;
        let item = this.#override[new_index];
        if (item === undefined) {
            if (new_index < 0)
                return;
            item = new_index == 0 ? '' :
                   this.#provider.get_at_index(this.#latest_idx + 1 - new_index);
            if (item === undefined) {
                return;
            }
        }
        this.#index_offset = new_index;
        return item;
    }
    reset() {
        this.#latest_idx = undefined;
        this.#index_offset = 0;
        this.#override = [];
    }
}
