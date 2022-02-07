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
    #last_circuit_changed

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
        this.#last_circuit_changed = undefined;
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
        this.#circuitUpdated.fire({ run: false, keep: false });
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
            return false;
        // We must not copy `after` here since the caller (in particular #circuitEdit)
        // may mutate the object to merge in changes later.
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
        return true;
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
    #circuitEdit(after, label, new_circuit) {
        const before = this.#circuit;
        this.#circuit = after;
        const changed = this.#createEdit(before, after, label, (circuit) => {
            this.#circuit = circuit;
            this.#last_circuit_changed = undefined;
            this.#circuitUpdated.fire({ run: false, keep: !new_circuit });
        });
        if (!changed) {
            this.#last_circuit_changed = undefined;
            return;
        }
        this.#last_circuit_changed = after;
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
        this.#circuitEdit(res.output, 'Synthesis', true);
        this.tick = 0;
        this.#circuitUpdated.fire({ run: true, keep: false }); // force a run
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
        this.#circuitEdit(message.circuit, label, false);
    }
    #processAutoLayout(message) {
        // If some user action triggers the automatic layout of the circuit,
        // we want to merge the change of the layout to the edit that corresponds
        // to that action, which we'll assume be the previous edit of the ciruit.
        // There are a few cases that we need to be careful though,
        // 1. we don't want to create a new edit just for the auto layout
        //    since it'll make undo basically a no-op (it will trigger another auto layout
        //    and get us back to exactly where we started)
        //    and might confuse the vscode history management.
        //    This means that if we don't have an edit to merge with,
        //    we should not generate a new edit
        // 2. we need to ignore the potential auto layout event after load/undo/redo/revert
        //    since those should set the document to a state that should be clean
        //    unless the user does something explicity.
        // For these reasons, we'll clear the last circuit change if the edit was a no-op
        // and after load/undo/redo/revert.
        if (!this.#last_circuit_changed) {
            this.#circuit = message.circuit;
            return;
        }
        for (const key in this.#last_circuit_changed)
            delete this.#last_circuit_changed[key];
        Object.assign(this.#last_circuit_changed, message.circuit);
        this.#circuit = this.#last_circuit_changed;
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
            case 'autolayout':
                this.#processAutoLayout(message);
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
            case 'do-synth':
                return this.doSynth();
        }
    }
}
