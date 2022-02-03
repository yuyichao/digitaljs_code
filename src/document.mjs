//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import _ from 'lodash';
import { run_yosys } from './requests.mjs';
import { Sources } from './sources.mjs';
import { rel_compat2, write_txt_file } from './utils.mjs';

const default_synth_options = {
    opt: false,
    transform: true,
    // lint: true,
    fsm: 'no', // (no)/yes/nomap
    fsmexpand: false
};

let doc_id = 1;

export class Document {
    #sources
    #extra_data = {}
    #synth_options = { ...default_synth_options }
    #circuit = { devices: {}, connectors: [], subcircuits: {} }

    #tick = 0
    #iopanelViews = []
    #iopanelViewIndices = {}
    #runStates = { hascircuit: false, running: false, pendingEvents: false }

    #doc_id

    // Events
    sourcesUpdated // fired for all updates
    synthOptionUpdated
    #synthOptionUpdated // not fired for updates from synthesis panel
    circuitUpdated
    #circuitUpdated // not fired for updates from main circuit views
    documentEdited
    #documentEdited

    tickUpdated // from circuit view to other view
    #tickUpdated
    showMarker
    #showMarker
    iopanelMessage
    #iopanelMessage
    runStatesUpdated
    #runStatesUpdated
    constructor(doc_uri, data) {
        this.#doc_id = doc_id++;
        this.#sources = new Sources();
        this.sourcesUpdated = this.#sources.onChanged;
        this.#load(doc_uri, data);
        this.#synthOptionUpdated = new vscode.EventEmitter();
        this.synthOptionUpdated = this.#synthOptionUpdated.event;
        this.#circuitUpdated = new vscode.EventEmitter();
        this.circuitUpdated = this.#circuitUpdated.event;
        this.#documentEdited = new vscode.EventEmitter();
        this.documentEdited = this.#documentEdited.event;

        this.#tickUpdated = new vscode.EventEmitter();
        this.tickUpdated = this.#tickUpdated.event;
        this.#showMarker = new vscode.EventEmitter();
        this.showMarker = this.#showMarker.event;
        this.#iopanelMessage = new vscode.EventEmitter();
        this.iopanelMessage = this.#iopanelMessage.event;
        this.#runStatesUpdated = new vscode.EventEmitter();
        this.runStatesUpdated = this.#runStatesUpdated.event;
    }
    dispose() {
        this.#sources.dispose();
    }

    // Properties
    get uri() {
        return this.#sources.doc_uri;
    }
    get doc_id() {
        return this.#doc_id;
    }
    get sources() {
        return this.#sources;
    }
    get tick() {
        return this.#tick;
    }
    set tick(tick) {
        if (tick == this.#tick)
            return;
        this.#tick = tick;
        this.#tickUpdated.fire(tick);
    }
    get synth_options() {
        return this.#synth_options;
    }
    set synth_options(synth_options) {
        const before = this.#synth_options;
        this.#synth_options = { ...synth_options };
        const after = this.#synth_options;
        this.#createEdit(before, after, 'Update options', (options) => {
            this.#synth_options = { ...options };
            this.#synthOptionUpdated.fire();
        });
    }
    get circuit() {
        return this.#circuit;
    }
    get iopanelViews() {
        return this.#iopanelViews;
    }
    get runStates() {
        return this.#runStates;
    }

    // Loading and saving
    #load_sources(doc_uri, data) {
        if (data.sources) {
            this.#sources.load(doc_uri, data.sources);
            return;
        }
        if (data.source_map) {
            const sources = [];
            for (const name in data.source_map)
                sources.push({ ...data.source_map[name], name });
            this.#sources.load(doc_uri, sources);
        }
        else {
            this.#sources.doc_uri = doc_uri;
        }
        if (data.files) {
            for (const file of data.files) {
                this.#sources.addSource(vscode.Uri.joinPath(doc_uri, '..', file));
            }
        }
    }
    #load(doc_uri, data) {
        this.#load_sources(doc_uri, data);
        delete data.files;
        delete data.source_map;
        delete data.sources;

        if (data.options)
            this.#synth_options = { ...default_synth_options, ...data.options };
        delete data.options;

        this.#circuit = { devices: {}, connectors: [], subcircuits: {} };
        for (const fld of ['devices', 'connectors', 'subcircuits']) {
            const v = data[fld];
            if (v)
                this.#circuit[fld] = v;
            delete data[fld];
        }
        this.#extra_data = data;
    }
    #toBackup() {
        return {
            sources: this.#sources.toBackup(),
            options: this.#synth_options,
            ...this.#circuit,
            ...this.#extra_data,
        };
    }
    #toSave(doc_uri) {
        const [sources, has_fullpath] = this.#sources.toSave(doc_uri);
        if (has_fullpath)
            vscode.window.showWarningMessage(`Saved project contains full path to source file.`);
        return {
            sources: sources,
            options: this.#synth_options,
            ...this.#circuit,
            ...this.#extra_data,
        };
    }
    async saveAs(doc_uri) {
        doc_uri = doc_uri || this.#sources.doc_uri;
        if (!doc_uri)
            return vscode.window.showErrorMessage('Please select a path to save as.');
        try {
            const str = JSON.stringify(this.#toSave(doc_uri));
            await write_txt_file(doc_uri, str);
        }
        catch (e) {
            console.error(e);
            return vscode.window.showErrorMessage(`Saving to ${doc_uri} failed: ${e}`);
        }
    }
    save() {
        return this.saveAs();
    }
    async revert(data) {
        this.#load(this.#sources.doc_uri, data);
        this.tick = 0;
        this.#clearMarker();
        this.#sources.refresh();
        this.#circuitUpdated.fire(false);
        this.#synthOptionUpdated.fire();
    }
    async backup(dest) {
        const str = JSON.stringify(this.#toBackup());
        await write_txt_file(dest, str);
        return {
            id: dest.toString(),
            delete: async () => {
                try {
                    await vscode.workspace.fs.delete(dest);
                }
                catch {
                    // noop
                }
            }
        };
    }

    // Edits
    #createEdit(before, after, label, cb) {
        if (_.isEqual(before, after))
            return;
        this.#documentEdited.fire({
            document: this,
            label: label,
            redo: () => {
                cb(after);
            },
            undo: () => {
                cb(before);
            },
        });
    }

    // Actions
    #sourceEdit(cb, label) {
        const before = this.#sources.toBackup();
        cb();
        const after = this.#sources.toBackup();
        this.#createEdit(before, after, label, (sources) => {
            this.#sources.load(this.#sources.doc_uri, sources);
            this.#sources.refresh();
        });
    }
    addSources(files) {
        this.#sourceEdit(() => {
            for (const file of files)
                this.#sources.addSource(file);
            this.#sources.refresh();
        }, 'Add source');
    }
    removeSource(file) {
        this.#sourceEdit(() => {
            this.#sources.deleteSource(file);
            this.#sources.refresh();
        }, 'Remove source');
    }
    #circuitEdit(after, label) {
        const before = this.#circuit;
        this.#circuit = after;
        this.#createEdit(before, after, label, (circuit) => {
            this.#circuit = circuit;
            this.#circuitUpdated.fire(false);
        });
    }
    async doSynth() {
        // Load a snapshot of the options up front
        const res = await this.#sources.doSynth({
            optimize: this.#synth_options.opt,
            fsm: this.#synth_options.fsm == "no" ? "" : this.#synth_options.fsm,
            fsmexpand: this.#synth_options.fsmexpand,
            lint: false,
            transform: this.#synth_options.transform,
        });
        if (!res)
            return;
        // The side panel should receive focus when we do synthesis
        // but it should already have focus so we don't need to do anything.
        this.#circuitEdit(res.output, 'Synthesis');
        this.tick = 0;
        this.#circuitUpdated.fire(true); // force a run
        return true;
    }
    #processMarker(markers) {
        const editor_map = {};
        const getEditorInfo = (name) => {
            let edit_info = editor_map[name];
            if (edit_info)
                return edit_info;
            const src_info = this.sources.findByName(name);
            if (!src_info)
                return;
            const editor = src_info.findEditor();
            if (!editor)
                return;
            edit_info = { editor, markers: [] };
            editor_map[name] = edit_info;
            return edit_info;
        };
        for (const marker of markers) {
            const edit_info = getEditorInfo(marker.name);
            if (!edit_info)
                continue;
            edit_info.markers.push(new vscode.Range(marker.from_line, marker.from_col,
                                                    marker.to_line, marker.to_col));
        }
        this.#showMarker.fire(editor_map);
    }
    #clearMarker() {
        this.#showMarker.fire({});
    }
    #updateCircuit(message) {
        let label;
        let ele_type = message.ele_type || 'Device';
        if (message.type === 'pos') {
            label = `Moving ${ele_type}`;
        }
        else if (message.type === 'vert') {
            label = `Deforming ${ele_type}`;
        }
        else if (message.type === 'src' || message.type === 'tgt') {
            label = `Reconnecting ${ele_type}`;
        }
        else if (message.type === 'add') {
            label = `Adding ${ele_type}`;
        }
        else if (message.type === 'rm') {
            label = `Removing ${ele_type}`;
        }
        else {
            label = `Editing ${ele_type}`;
        }
        this.#circuitEdit(message.circuit, label);
    }

    // Messages
    #processIOPanelMessage(message) {
        // Cache the state here for the status view at initialization time.
        switch (message.command) {
            case 'iopanel:view': {
                this.#iopanelViewIndices = {};
                for (const idx in message.view)
                    this.#iopanelViewIndices[message.view[idx]] = idx;
                this.#iopanelViews = message.view;
            }
            case 'iopanel:update': {
                const idx = this.#iopanelViewIndices[message.id];
                if (idx !== undefined) {
                    this.#iopanelViews[idx].value = message.value;
                }
            }
        }
        this.#iopanelMessage.fire(message);
    }
    processCommand(message) {
        if (message.command.startsWith('iopanel:')) {
            this.#processIOPanelMessage(message);
            return;
        }
        switch (message.command) {
            case 'updatecircuit':
                this.#updateCircuit(message);
                return;
            case 'tick':
                this.tick = message.tick;
                return;
            case 'runstate':
                this.#runStates = { hascircuit: message.hascircuit,
                                    running: message.running,
                                    pendingEvents: message.pendingEvents };
                this.#runStatesUpdated.fire(this.#runStates);
                return;
            case 'luastarted':
                this.#sources.scriptStarted(message.name);
                return;
            case 'luastop':
                this.#sources.scriptStopped(message.name);
                return;
            case 'luaerror': {
                let name = message.name;
                let uri = vscode.Uri.parse(name);
                if (rel_compat2(this.#sources.doc_dir_uri, uri))
                    name = path.relative(this.#sources.doc_dir_uri.path, uri.path);
                vscode.window.showErrorMessage(`${name}: ${message.message}`);
                return;
            }
            case 'luaprint': {
                let name = message.name;
                let uri = vscode.Uri.parse(name);
                if (rel_compat2(this.#sources.doc_dir_uri, uri))
                    name = path.relative(this.#sources.doc_dir_uri.path, uri.path);
                vscode.window.showInformationMessage(`${name}: ${message.messages.join('\t')}`);
                return;
            }
            case 'showmarker':
                return this.#processMarker(message.markers);
            case 'clearmarker':
                return this.#clearMarker();
        }
    }
}
