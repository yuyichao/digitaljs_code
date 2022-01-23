//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import yosys from 'yosysjs';
import yosys2digitaljs from 'yosys2digitaljs';
import * as digitaljs_transform from '../node_modules/digitaljs/src/transform.mjs';

const rand_prefix = 'djs-IxU5De4QZDxUgn43Zwj1-_';
const rand_suffix = '_-hbtdHFLoSvFPbPLnGSp8';
const match_regex = new RegExp(`${rand_prefix}(\\d+)${rand_suffix}`, 'g');

class FileMap {
    #names = []
    map_name(name) {
        const idx = this.#names.length;
        this.#names.push(name);
        return `${rand_prefix}${idx}${rand_suffix}`;
    }
    unmap_string(str) {
        return str.replaceAll(match_regex, (match, p1) => this.#names[parseInt(p1)]);
    }
}

let yosysWasmURI;

export function set_yosys_wasm_uri(uri) {
    yosysWasmURI = uri;
}

class Yosys {
    static #wasmBinary
    static async #getWasmBinary() {
        if (!Yosys.#wasmBinary)
            Yosys.#wasmBinary = await vscode.workspace.fs.readFile(yosysWasmURI);
        return Yosys.#wasmBinary;
    }
    #FS
    #ccall
    #file_map = new FileMap();
    async init() {
        const M = {
            wasmBinary: await Yosys.#getWasmBinary(),
        };
        await yosys(M);
        this.#FS = M.FS;
        this.#ccall = M.ccall;
        // Yosys::yosys_setup()
        M.ccall('_ZN5Yosys11yosys_setupEv', '', []);
    }
    #run(cmd) {
        this.#ccall('run', '', ['string'], [cmd]);
    }
    process_files(files, opts = {}) {
        try {
            this.#run('design -reset');
            for (const name in files) {
                const ext = path.extname(name);
                const pre_ext = name.substring(0, name.length - ext.length);
                const escaped_name = this.#file_map.map_name(pre_ext) + ext;
                this.#FS.writeFile(escaped_name, files[name]);
                if (ext == '.sv') {
                    this.#run(`read_verilog -sv ${escaped_name}`);
                }
                else {
                    this.#run(`read_verilog ${escaped_name}`);
                }
            }
            this.#run('hierarchy -auto-top');
            this.#run('proc');
            this.#run(opts.optimize ? 'opt' : 'opt_clean');
            if (opts.fsm && opts.fsm != 'no') {
                const fsmexpand = opts.fsmexpand ? " -expand" : "";
                this.#run(options.fsm == "nomap" ? "fsm -nomap" + fsmexpand : "fsm" + fsmexpand);
            }
            this.#run('memory -nomap');
            this.#run('wreduce -memx');
            this.#run(opts.optimize ? 'opt -full' : 'opt_clean');
            this.#run('json -o /output.json');
        }
        catch {
            const error = this.#file_map.unmap_string(this.#ccall('errmsg', 'string', [], []));
            throw { error };
        }
        const output = JSON.parse(this.#file_map.unmap_string(
            new TextDecoder().decode(this.#FS.readFile('/output.json'))));
        return output;
    }
}

export async function run_yosys(files, options) {
    const yosys = new Yosys();
    await yosys.init();
    const obj = yosys.process_files(files, options);
    const portmaps = yosys2digitaljs.order_ports(obj);
    const out = yosys2digitaljs.yosys_to_digitaljs(obj, portmaps, options);
    const toporder = yosys2digitaljs.topsort(yosys2digitaljs.module_deps(obj));
    toporder.pop();
    const toplevel = toporder.pop();
    let output = { subcircuits: {}, ... out[toplevel] };
    for (const x of toporder)
        output.subcircuits[x] = out[x];
    yosys2digitaljs.io_ui(output);
    if (options.transform)
        output = digitaljs_transform.transformCircuit(output);
    return { output };
}
