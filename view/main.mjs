//

'use strict';

import './scss/app.scss';
import $ from 'jquery';
import * as digitaljs from 'digitaljs';
import * as digitaljs_lua from 'digitaljs_lua';
import svgPanZoom from 'svg-pan-zoom';
import Hammer from 'hammerjs';
import ResizeObserver from 'resize-observer-polyfill';
import Split from 'split-grid';
import * as imgutils from './imgutils.mjs';
import { MonitorView } from './monitor.mjs';
import { RemoteIOPanel } from './iopanel.mjs';

const vscode = acquireVsCodeApi();

digitaljs.paperOptions.gridSize = 0.5;
digitaljs.paperOptions.moveThreshold = 10;

function circuit_empty(circuit) {
    if (!circuit)
        return true;
    if (Object.entries(circuit).length == 0)
        return true;

    const devices = circuit.devices;
    if (devices && Object.entries(devices).length != 0)
        return false;

    const connectors = circuit.connectors;
    if (connectors.length != 0)
        return false;

    const subcircuits = circuit.subcircuits;
    if (subcircuits && Object.entries(subcircuits).length != 0)
        return false;
    return true;
}

const $window = $(window);
function max_dialog_width() {
    return $window.width() * 0.9;
}
function max_dialog_height() {
    return $window.height() * 0.9;
}

class LuaRunner {
    #djs
    #runners
    constructor(djs) {
        this.#djs = djs;
        this.#runners = {};
    }

    #error(name, e) {
        vscode.postMessage({ command: "luaerror", name, message: e.luaMessage });
    }
    #getRunner(name) {
        let runner = this.#runners[name];
        if (runner)
            return runner;
        runner = new digitaljs_lua.LuaRunner(this.#djs.circuit);
        runner.on('thread:stop', (pid) => {
            vscode.postMessage({ command: "luastop", name });
        });
        runner.on('thread:error', (pid, e) => {
            this.#error(name, e);
        });
        runner.on('print', msgs => {
            vscode.postMessage({ command: "luaprint", name, messages: msgs });
        });
        this.#runners[name] = runner;
        return runner;
    }
    run(name, script) {
        this.stop(name);
        const runner = this.#getRunner(name);
        let pid;
        try {
            pid = runner.runThread(script);
            runner.running_pid = pid;
        }
        catch (e) {
            if (e instanceof digitaljs_lua.LuaError) {
                this.#error(name, e);
            }
            else {
                throw e;
            }
        }
        if (pid !== undefined) {
            vscode.postMessage({ command: "luastarted", name });
        }
    }
    stop(name) {
        const helper = this.#runners[name];
        if (!helper)
            return;
        const pid = helper.running_pid;
        if (pid === undefined)
            return;
        if (helper.isThreadRunning(pid)) {
            helper.stopThread(pid);
            delete helper.running_pid;
        }
    }
    shutdown() {
        for (const h of Object.values(this.#runners))
            h.shutdown();
        this.#runners = {};
    }
}

class ChangeTracker {
    #timer
    #info
    get info() {
        return this.#info;
    }
    clear() {
        if (this.#timer)
            clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#info = undefined;
    }
    queue(timeout, info, cb) {
        if (this.#timer)
            clearTimeout(this.#timer);
        this.#info = info;
        this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#info = undefined;
            cb();
        }, timeout);
    }
}

class SubCircuitTracker {
    #count = 0
    #subcircuits = {}
    #refresh() {
        vscode.postMessage({ command: "subcircuits", subcircuits: this.titles() });
    }
    clear() {
        this.#count = 0;
        this.#subcircuits = {};
        this.#refresh();
    }
    add(title, svg, type) {
        const id = ++this.#count;
        this.#subcircuits[id] = { title, svg, type };
        this.#refresh();
        return id;
    }
    remove(id) {
        delete this.#subcircuits[id];
        this.#refresh();
    }
    find(id) {
        return this.#subcircuits[id];
    }
    titles() {
        const res = {};
        for (const id in this.#subcircuits) {
            const item = this.#subcircuits[id];
            res[id] = { title: item.title, type: item.type };
        }
        return res;
    }
}

class Engine extends digitaljs.engines.WorkerEngine {
    constructor(graph, opts) {
        const restore_graph_states = (graph, signals) => {
            if (!signals)
                return;
            for (const gate of graph.getElements()) {
                const sub_signals = signals[gate.id];
                if (!sub_signals)
                    continue;
                if (gate.get('type') == 'Subcircuit')
                    restore_graph_states(gate.get('graph'), sub_signals.sub_signals);
                gate.set('outputSignals', sub_signals.output);
                gate.set('inputSignals', sub_signals.input);
            }
        };
        restore_graph_states(graph, opts.signals);
        super(graph, opts);
    }
}

class Dialog {
    #dialog
    close_cb
    used = true;
    constructor(mgr, key) {
        this.#dialog = $('<div>').appendTo('html > body');
        const observer = new ResizeObserver(() => {
            const mw = max_dialog_width();
            if (this.#dialog.width() > mw)
                this.#dialog.dialog("option", "width", mw);
            const mh = max_dialog_height();
            if (this.#dialog.height() > mh)
                this.#dialog.dialog("option", "height", mh);
        });
        observer.observe(this.#dialog[0]);
        this.#dialog.dialog({
            width: 'auto',
            height: 'auto',
            maxWidth: max_dialog_width(),
            maxHeight: max_dialog_height(),
            close: () => {
                mgr.dialogs.delete(key);
                observer.disconnect();
                this.shutdown();
            },
        });
        mgr.dialogs.set(key, this);
    }
    get dialog() {
        return this.#dialog;
    }
    widget() {
        return this.#dialog.dialog('widget');
    }
    close() {
        this.#dialog.dialog('close');
    }
    option(opts) {
        this.#dialog.dialog('option', opts);
    }
    shutdown() {
        if (this.close_cb) {
            this.close_cb();
        }
    }
}

class DialogManager {
    #dialogs
    constructor() {
        this.#dialogs = new Map();
    }
    get dialogs() {
        return this.#dialogs;
    }
    #getDialog(key) {
        const dialog = this.#dialogs.get(key);
        if (dialog) {
            dialog.used = true;
            return { dialog, reuse: true };
        }
        return { dialog: new Dialog(this, key), reuse: false };
    }
    openDialog(key, div, title, resizable, close_cb, ctx) {
        const { dialog, reuse } = this.#getDialog(key);
        dialog.option({ title, resizable });
        dialog.close_cb = close_cb;
        div.detach().appendTo(dialog.dialog);
        dialog.context = ctx;
        // The dialog is created with empty content so if this is a new one
        // we should refresh the position calculation.
        // Note that this is still not ideal for subcircuits
        // since the elkjs layout is done asynchronously and will actually
        // happen after this.
        if (!reuse)
            dialog.widget().position({ my: "center", at: "center", of: window });
        return dialog;
    }
    saveStates() {
        for (const dialog of this.#dialogs.values()) {
            dialog.context.save();
            dialog.shutdown();
            dialog.used = false;
            dialog.close_cb = undefined;
        }
    }
    closeUnused() {
        this.#dialogs.forEach((dialog, key, dialogs) => {
            if (dialog.used)
                return;
            dialog.close();
            dialogs.delete(key);
        });
    }
}

class DialogContext {
    constructor(type, model_path, paper) {
        this.type = type;
        this.model_path = model_path;
        this.paper = paper;
    }
    save() {
        const paper = this.paper;
        delete this.paper;
        if (paper && paper._djs_panAndZoom) {
            this.transform = { zoom: paper._djs_panAndZoom.getZoom(),
                               pan: paper._djs_panAndZoom.getPan() };
        }
    }
}

class DigitalJS {
    #iopanel
    #monitor
    #monitormem
    #monitorview
    #paper
    #lua
    #change_tracker
    #subcircuit_tracker
    #model_paths
    #paper_in_flight
    #dialog_mgr
    #dialog_key_count = 0
    constructor() {
        this.circuit = undefined;
        this.#lua = new LuaRunner(this);
        this.#paper_in_flight = new Map();
        this.#change_tracker = new ChangeTracker();
        this.#dialog_mgr = new DialogManager();
        this.#subcircuit_tracker = new SubCircuitTracker();
        window.addEventListener('message', event => {
            this.#processMessage(event.data);
        });
        $(window).on('load', () => this.#initialize());
    }

    #initialize() {
        Split({
            rowGutters: [{
                element: document.querySelector('#gutter_vert'),
                track: 1
            }]
        });
        this.#updateRunStates();
        $('#monitorbox vscode-button').prop('disabled', true).off();

        // When we got a click in the webview, vscode will not handle this event
        // so it won't switch the focus to this editor.
        // This can make it confusing when multiple circuits are openned
        // (the size panel may be for a different circuit and
        // the start/pause simulation button on the editor title bar won't be shown).
        // Let's detect such events in the webview and tell the host to focus us.
        // This also matches the behavior of a normal editor.
        window.addEventListener('touchstart', () => {
            vscode.postMessage({ command: 'focus' });
        }, { capture: true, passive: true });
        window.addEventListener('mousedown', () => {
            vscode.postMessage({ command: 'focus' });
        }, { capture: true, passive: true });
        window.addEventListener('click', () => {
            vscode.postMessage({ command: 'focus' });
        }, { capture: true, passive: true });

        // Release the messages from the main extension
        // (though the run state update should've already realeased it...)
        vscode.postMessage({ command: 'initialized' });
        if (window.getImageSupport) {
            vscode.postMessage({ command: 'img-exts', exts: imgutils.supportedExts() });
        }
    }

    async #processMessage(message) {
        if (message.command.startsWith('iopanel:')) {
            if (this.#iopanel)
                this.#iopanel.processMessage(message);
            return;
        }
        switch (message.command) {
            case 'showcircuit':
                this.#mkCircuit(message.circuit, message.opts);
                return;
            case 'pausesim':
                this.#pauseSim();
                return;
            case 'startsim':
                this.#startSim();
                return;
            case 'singlestepsim':
                this.#singleStepSim();
                return;
            case 'nexteventsim':
                this.#nextEventSim();
                return;
            case 'fastforwardsim':
                this.#fastForwardSim();
                return;
            case 'runlua':
                this.#lua.run(message.name, message.script);
                return;
            case 'stoplua':
                this.#lua.stop(message.name);
                return;
            case 'exportimage': {
                const post_reply = (data, base64) => {
                    vscode.postMessage({ command: "saveimg", data, base64, uri: message.uri });
                };
                const post_error = (message) => {
                    vscode.postMessage({ command: "saveimg-error", uri: message.uri, message });
                };
                if (!this.circuit)
                    return post_error('No active circuit');
                const export_image = async (ele) => {
                    // There are other and more generic ways to record and reset
                    // the scale of the image before saving.
                    // However, deleting the attribute added by svg-pan-zoom
                    // produces the most reproducible results.
                    const postclone = (svg) => {
                        const viewport = $(svg).children('.svg-pan-zoom_viewport');
                        viewport.css('transform', '');
                        if (!viewport.attr('style')) {
                            viewport.removeAttr('style');
                        }
                        viewport.removeAttr('transform');
                    };
                    const img_options = { global_postclone: postclone };
                    try {
                        if (message.type == 'image/svg+xml') {
                            const svg = imgutils.toSvg(ele, img_options);
                            return post_reply(svg, false);
                        }
                        const canvas = await imgutils.toCanvas(ele, img_options);
                        const t = message.type;
                        const dataurl = canvas.toDataURL(t, 1);
                        const prefix = `data:${t};base64,`;
                        if (!dataurl.startsWith(prefix))
                            return post_error(`Unsupported image type ${t}`);
                        return post_reply(dataurl.substring(prefix.length), true);
                    }
                    catch (e) {
                        console.error(e);
                        return post_error('Unknown error');
                    }
                };
                if (!message.subcircuit)
                    return export_image($('#paper > .joint-paper > svg')[0]);
                const sub = this.#subcircuit_tracker.find(message.subcircuit);
                // Check title mismatch in case something has changed since user's selection
                if (!sub || sub.title !== message.subcircuit_title)
                    return post_error('Unable to find subcircuit');
                return export_image(sub.svg);
            }
        }
    }

    #registerPaper(paper) {
        const show_marker = (cellView) => {
            let markers = [];
            const positions = cellView.model.get('source_positions');
            if (!positions)
                return;
            for (const pos of positions) {
                const marker = {name: pos.name,
                                from_line: pos.from.line - 1, from_col: pos.from.column - 1,
                                to_line: pos.to.line - 1, to_col: pos.to.column - 1};
                if (marker.from_line < 0 || marker.to_line < 0 ||
                    marker.from_col < 0 || marker.to_col < 0)
                    continue;
                markers.push(marker);
            }
            if (markers.length) {
                vscode.postMessage({ command: "showmarker", markers });
            }
        };
        const clear_marker = () => {
            vscode.postMessage({ command: "clearmarker" });
        };
        paper.on('cell:mouseenter', show_marker);
        paper.on('cell:pointerclick', show_marker); // Try to support touch
        paper.on('cell:mouseleave', clear_marker);
        paper.on('blank:pointerclick', clear_marker); // Try to support touch

        if (paper !== this.#paper)
            this.#paper_in_flight.set(paper.el, paper);

        let currentScale = 1;
        let hammer;

        const svgEventsHandler = {
            haltEventListeners: ['touchstart', 'touchend', 'touchmove',
                                 'touchleave', 'touchcancel'],
            init: (options) => {
                const instance = options.instance;

                // Init Hammer
                // Listen only for pointer and touch events
                hammer = Hammer(options.svgElement, {
                    inputClass: Hammer.SUPPORT_POINTER_EVENTS ? Hammer.PointerEventInput :
                                Hammer.TouchInput
                });

                // Enable pinch
                hammer.get('pinch').set({enable: true});

                // Handle pan
                const pan_state = {
                    enabled: false,
                    init_dist: undefined
                };
                hammer.on('panstart panmove', (ev) => {
                    if (!instance.isPanEnabled()) {
                        pan_state.enabled = false;
                        return;
                    }
                    // On pan start reset panned variables
                    if (ev.type === 'panstart') {
                        pan_state.enabled = true;
                        const init_pan = instance.getPan();
                        pan_state.init_dist = { x: init_pan.x - ev.center.x,
                                                y: init_pan.y - ev.center.y };
                    }
                    else if (!pan_state.enabled) {
                        return;
                    }
                    instance.pan({ x: pan_state.init_dist.x + ev.center.x,
                                   y: pan_state.init_dist.y + ev.center.y });
                });
                hammer.on('pancancel panend', () => {
                    pan_state.enabled = false;
                });

                // Handle pinch
                const pinch_state = {
                    enabled: false,
                    init_scale: 1,
                    init_dist: undefined,
                };
                hammer.on('pinchstart pinchmove', (ev) => {
                    if (!instance.isPanEnabled()) {
                        pinch_state.enabled = false;
                        return;
                    }
                    // On pinch start remember initial zoom
                    if (ev.type === 'pinchstart') {
                        pinch_state.enabled = true;
                        pinch_state.init_scale = instance.getZoom();
                        const init_pan = instance.getPan();
                        pinch_state.init_dist = { x: init_pan.x - ev.center.x,
                                                  y: init_pan.y - ev.center.y };
                    }
                    else if (!pinch_state.enabled) {
                        return;
                    }

                    instance.zoom(pinch_state.init_scale * ev.scale);
                    // The zoom level may not be what we requested when it hits the limit
                    const scale = instance.getZoom() / pinch_state.init_scale;
                    instance.pan({ x: pinch_state.init_dist.x * scale + ev.center.x,
                                   y: pinch_state.init_dist.y * scale + ev.center.y });
                });
                hammer.on('pinchcancel pinchend', () => {
                    pinch_state.enabled = false;
                });

                // Hammer seems to be preventing the touch events from generating
                // the double click for tapping so we need to handle that separately here.
                hammer.on('doubletap', (ev) => {
                    if (currentScale >= 0.99 && currentScale <= 2)
                        return panAndZoom.zoomAtPoint(currentScale * 1.5,
                                                      { x: ev.center.x, y: ev.center.y });
                    panAndZoom.reset();
                });

                // Prevent moving the page on some devices when panning over SVG
                options.svgElement.addEventListener('touchmove', (e) => {
                    if (!pinch_state.enabled && !pan_state.enabled)
                        return;
                    e.preventDefault();
                });
            },
            destroy: () => {
                hammer.destroy();
            }
        };

        const panAndZoom = svgPanZoom(paper.svg, {
            fit: false,
            center: false,
            dblClickZoomEnabled: false,
            mouseWheelZoomEnabled: true,
            zoomScaleSensitivity: 0.2,
            panEnabled: false,
            zoomEnabled: true,
            customEventsHandler: svgEventsHandler,
            mouseWheelEventFilter: (evt) => {
                return (evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey;
            },
            onZoom: function(scale) {
                currentScale = scale;
            }
        });
        paper._djs_panAndZoom = panAndZoom;

        // Enable pan when a blank area is click (held) on
        paper.on('blank:pointerdown', () => {
            panAndZoom.enablePan();
        });

        // Disable pan when the mouse button is released
        paper.on('cell:pointerup blank:pointerup', () => {
            panAndZoom.disablePan();
        });

        // Double click to zoom in until a certain size before reset
        paper.on('blank:pointerdblclick', (ev) => {
            if (currentScale >= 0.99 && currentScale <= 2)
                return panAndZoom.zoomAtPoint(currentScale * 1.5,
                                              { x: ev.offsetX, y: ev.offsetY });
            panAndZoom.reset();
        });
    }
    #queueCallback(ele, evt_type) {
        const cid = ele.cid;
        const attr = ele.attributes;
        const ele_type = attr ? attr.type : undefined;
        const info = { type: evt_type, cid, ele_type: ele_type };
        // This is a long timeout but this should be fine since we rely on the
        // batch:stop event to mark the end of an edit.
        // The timeout here should only be triggerred if the user pauses
        // in the middle of a drag for a long time.
        this.#change_tracker.queue(3000, info, () => {
            // If this is a wire and at least one of the end isn't connected, try again later.
            const attr = ele.attributes;
            if (attr && ele_type === 'Wire' && (!attr.source.id || !attr.target.id))
                return this.#queueCallback(ele, evt_type);
            vscode.postMessage({ command: "updatecircuit",
                                 circuit: this.circuit.toJSON(), type: evt_type, ele_type });
        });
    }
    #checkAndQueueChange(ele, evt_type) {
        const cid = ele.cid;
        const old_info = this.#change_tracker.info;
        if (old_info && (old_info.type !== evt_type || old_info.cid !== cid)) {
            // If this has just been added,
            // keep marking it as add in case it was deleted immediately after.
            if (old_info.type == 'add' && old_info.cid == cid)
                return this.#queueCallback(ele, 'add');
            // Different change compared to the last one, save previous value.
            const attr = ele.attributes;
            ele.attributes = ele._previousAttributes;
            const circuit = this.circuit.toJSON();
            ele.attributes = attr;
            vscode.postMessage({ command: "updatecircuit", circuit,
                                 type: old_info.type, ele_type: old_info.ele_type });
        }
        this.#queueCallback(ele, evt_type);
    }
    async #collectStates() {
        const observe_graph = (graph) => {
            if (!graph)
                return;
            this.circuit._engine.observeGraph(graph);
            for (const gate of graph.getElements()) {
                if (gate.get('type') == 'Subcircuit') {
                    observe_graph(gate.get('graph'));
                }
            }
        };
        if (this.circuit && this.circuit._graph)
            observe_graph(this.circuit._graph);
        const sync = this.circuit ? this.circuit.synchronize() : undefined;

        const states = {};
        if (this.#paper && this.#paper._djs_panAndZoom) {
            states.main_transform = {
                zoom: this.#paper._djs_panAndZoom.getZoom(),
                pan: this.#paper._djs_panAndZoom.getPan(),
            };
        }
        states.signals = {};
        await sync;
        const collect_graph_states = (graph, signals) => {
            for (const gate of graph.getElements()) {
                signals[gate.id] = { input: gate.get('inputSignals'),
                                     output: gate.get('outputSignals') };
                if (gate.get('type') == 'Subcircuit') {
                    signals[gate.id].sub_signals = {};
                    collect_graph_states(gate.get('graph'), signals[gate.id].sub_signals);
                }
            }
        };
        if (this.circuit && this.circuit._graph)
            collect_graph_states(this.circuit._graph, states.signals);

        if (this.circuit)
            states.tick = this.circuit.tick;

        this.#dialog_mgr.saveStates();

        return states;
    }
    #restoreStates(states, keep) {
        if (!keep)
            return;
        if (this.#paper && this.#paper._djs_panAndZoom) {
            this.#paper._djs_panAndZoom.zoom(states.main_transform.zoom);
            this.#paper._djs_panAndZoom.pan(states.main_transform.pan);
        }
        const find_model = (graph, path) => {
            const cell = graph.getCell(path[0]);
            if (path.length == 1)
                return cell;
            if (cell.get('type') !== 'Subcircuit')
                return;
            return find_model(cell.get('graph'), path.slice(1));
        };
        for (const [key, dialog] of this.#dialog_mgr.dialogs.entries()) {
            const context = dialog.context;
            const model = find_model(this.circuit._graph, context.model_path);
            const model_type = model.get('type');
            if (model_type !== context.type)
                continue;
            if (model_type === 'Subcircuit') {
                const sub = this.circuit.createSubcircuit(model);
                if (context.transform) {
                    sub.paper._djs_panAndZoom.zoom(context.transform.zoom);
                    sub.paper._djs_panAndZoom.pan(context.transform.pan);
                }
                this.#openDialog(key, model_type, sub.div, sub.close, model);
            }
            else if (model_type === 'FSM') {
                const sub = model.createEditor();
                this.#openDialog(key, model_type, sub.div, sub.close, model);
            }
            else if (model_type === 'Memory') {
                const sub = model.createEditor();
                this.#openDialog(key, model_type, sub.div, sub.close, model);
            }
        }
    }
    #collectModels(graph) {
        this.#model_paths = new Map();
        const collect_models = (graph, path) => {
            for (const gate of graph.getElements()) {
                const gate_type = gate.get('type');
                if (gate_type === 'Subcircuit') {
                    const subpath = [ ...path, gate.id ];
                    this.#model_paths.set(gate, subpath);
                    collect_models(gate.get('graph'), subpath);
                }
                else if (gate_type === 'Memory' || gate_type === 'FSM') {
                    this.#model_paths.set(gate, [...path, gate.id]);
                }
            }
        };
        collect_models(graph, []);
    }
    #openDialog(key, type, div, close_cb, model) {
        let id;
        let paper;
        const title = div.attr('title') || `Unknown ${type || 'Subcircuit'}`;
        div.removeAttr('title');
        if (type !== "Memory") {
            const svg = div.find('svg');
            id = this.#subcircuit_tracker.add(title, svg[0], type);
            if (type === "Subcircuit") {
                const paper_el = $(div).find('div.joint-paper')[0];
                paper = this.#paper_in_flight.get(paper_el);
                this.#paper_in_flight.delete(paper_el);
            }
        }

        const model_path = this.#model_paths.get(model);
        const context = new DialogContext(type, model_path, paper);
        // On reload, the close callback is called before the circuit is destroyed
        // which would have disconnected the shutdown callback.
        // Therefore, the shutdown callback should only be called when the circuit
        // is shutdown for some other reasons (which shouldn't really happen).
        // But if it does happen, we'll close the dialog just to be safe.
        const shutdownCallback = () => { dialog.close(); };
        this.circuit.listenToOnce(this.circuit, 'shutdown', shutdownCallback);
        this.#dialog_mgr.openDialog(key, div, title, type !== "Memory", () => {
            if (id !== undefined)
                this.#subcircuit_tracker.remove(id);
            this.circuit.stopListening(this.circuit, 'shutdown', shutdownCallback);
            close_cb();
        }, context);
    }
    async #mkCircuit(data, opts) {
        try {
            await this.#_mkCircuit(data, opts);
        }
        finally {
            this.#dialog_mgr.closeUnused();
        }
    }
    async #_mkCircuit(data, opts) {
        let run_circuit = false;
        if (opts.run) {
            run_circuit = true;
        }
        else if (opts.pause) {
            run_circuit = false;
        }
        else if (this.circuit) {
            run_circuit = this.circuit.running
        }
        const old_states = await this.#collectStates();
        this.#destroyCircuit();
        if (circuit_empty(data)) {
            const paper_div = $('#paper');
            paper_div.html('<h1 style="text-align:center">No active circuit.</h1>');
            const btn = $('<p style="text-align:center"><vscode-button><i slot="start" class="codicon codicon-run"></i> Synthesize</vscode-button></p>');
            btn.click(() => vscode.postMessage({ command: "do-synth" }));
            paper_div.append(btn);
            return;
        }
        const circuit_opts = {
            layoutEngine: 'elkjs',
            engine: Engine,
            engineOptions: { workerURL: window.simWorkerUri,
                             signals: opts.keep ? old_states.signals : undefined,
                             initTick: opts.keep ? old_states.tick : undefined },
            windowCallback: (type, div, close_cb, { model }) => {
                this.#openDialog(++this.#dialog_key_count, type, div, close_cb, model);
            }
        };
        // The layout actually uses display information (i.e. the text widths of the labels)
        // so we can't really do it well on the host side
        // (it also means that we can't really guarantee portability)
        // and the circuit we loaded for the first time will have the layout information
        // applied.
        // However, we still don't want to treat these automatic layout changes as
        // user edits so we'll send them to the user in a different kind of message
        // to treat them as part of the previous edit.
        //
        // Note that since the auto layout is done lazily,
        // unless the user opens all the subcircuits, the initial circuit saved
        // might still not have all the layout info.
        let in_layout = false;
        this.circuit = new digitaljs.Circuit(data, circuit_opts);
        const reg_graph_listeners = (graph) => {
            this.circuit.listenTo(graph, 'change:position', (ele) => {
                if (in_layout)
                    return;
                this.#checkAndQueueChange(ele, 'pos');
            });
            this.circuit.listenTo(graph, 'change:vertices', (ele) => {
                if (in_layout)
                    return;
                this.#checkAndQueueChange(ele, 'vert');
            });
            this.circuit.listenTo(graph, 'change:source', (ele) => {
                if (in_layout)
                    return;
                this.#checkAndQueueChange(ele, 'src');
            });
            this.circuit.listenTo(graph, 'change:target', (ele) => {
                if (in_layout)
                    return;
                this.#checkAndQueueChange(ele, 'tgt');
            });
            this.circuit.listenTo(graph, 'add', (ele, cells) => {
                if (in_layout)
                    return;
                const evt_type = 'add';
                const old_info = this.#change_tracker.info;
                if (old_info) {
                    // An add is always a new event, take a snapshot of the old value
                    const tmp_cells = cells.clone();
                    tmp_cells.remove(ele);
                    cells.graph.attributes.cells = tmp_cells;
                    const circuit = this.circuit.toJSON();
                    cells.graph.attributes.cells = cells;
                    vscode.postMessage({ command: "updatecircuit", circuit,
                                         type: old_info.type, ele_type: old_info.ele_type });
                }
                this.#queueCallback(ele, evt_type);
            });
            this.circuit.listenTo(graph, 'remove', (ele, cells) => {
                if (in_layout)
                    return;
                const cid = ele.cid;
                const evt_type = 'rm';
                const old_info = this.#change_tracker.info;
                // A remove is never going to be merged with the next event.
                this.#change_tracker.clear();
                // If this is the one we are adding, ignore it
                if (old_info) {
                    if (old_info.type == 'add' && old_info.cid == cid)
                        return;
                    // If there's anything else that was in progress, generate a version for that.
                    const tmp_cells = cells.clone();
                    tmp_cells.add(ele);
                    cells.graph.attributes.cells = tmp_cells;
                    const circuit = this.circuit.toJSON();
                    cells.graph.attributes.cells = cells;
                    vscode.postMessage({ command: "updatecircuit", circuit,
                                         type: old_info.type, ele_type: old_info.ele_type });
                }
                const attr = ele.attributes;
                const ele_type = attr ? attr.type : undefined;
                vscode.postMessage({ command: "updatecircuit", circuit: this.circuit.toJSON(),
                                     type: evt_type, ele_type });
            });
            this.circuit.listenTo(graph, 'batch:start', (data) => {
                const batch_name = data.batchName;
                if (batch_name === 'layout') {
                    const old_info = this.#change_tracker.info;
                    // Flush the changes before the layout starts
                    if (old_info) {
                        this.#change_tracker.clear();
                        vscode.postMessage({ command: "updatecircuit",
                                             circuit: this.circuit.toJSON(),
                                             type: old_info.type,
                                             ele_type: old_info.ele_type });
                    }
                    in_layout = true;
                }
            });
            this.circuit.listenTo(graph, 'batch:stop', (data) => {
                const batch_name = data.batchName;
                if (batch_name === 'layout') {
                    vscode.postMessage({ command: "autolayout",
                                         circuit: this.circuit.toJSON() });
                    in_layout = false;
                    return;
                }
                if (in_layout)
                    return;
                // These events marks the end of a drag-and-move event
                // Out of the events that I've observed, we do not want to handle the
                // translation batch since it fires in the middle of dragging.
                if (batch_name === 'vertex-move' || batch_name === 'vertex-add' ||
                    batch_name === 'pointer') {
                    // The main case that we need to be careful about is the ordering with the
                    // remove event since it looks at the old info and do different things
                    // depend on if there was an add event of the same element previously.
                    // Fortunately, the remove event fires before the batch stop event
                    // so it'll handle the removal of an just-added wire before we do.
                    const info = this.#change_tracker.info;
                    if (info) {
                        vscode.postMessage({ command: "updatecircuit",
                                             circuit: this.circuit.toJSON(),
                                             type: info.type, ele_type: info.ele_type });
                        this.#change_tracker.clear();
                    }
                }
            });
            // Do not listen for the update from the subcircuits for now
            // since digitaljs currently doesn't support loading the same type of subcircuits
            // with different layout parameters.
            // Most likely, we'll need to patch it a bit ourselves but we should do that
            // in a backward compatible way...
            for (const cell of graph.getCells()) {
                if (cell.get('type') === 'Subcircuit') {
                    reg_graph_listeners(cell.get('graph'));
                }
            }
        };
        reg_graph_listeners(this.circuit._graph);
        this.#collectModels(this.circuit._graph);
        this.circuit.on('postUpdateGates', (tick) => {
            vscode.postMessage({ command: "tick", tick });
        });
        if (run_circuit)
            this.circuit.start();
        this.#monitor = new digitaljs.Monitor(this.circuit);
        if (this.#monitormem) {
            this.#monitor.loadWiresDesc(this.#monitormem);
            this.#monitormem = undefined;
        }
        this.#monitorview = new MonitorView({ model: this.#monitor, el: $('#monitor') });
        this.#iopanel = new RemoteIOPanel({
            model: this.circuit, el: $(''), vscode: vscode
        });
        this.#paper = this.circuit.displayOn($('<div>').appendTo($('#paper')));
        this.#registerPaper(this.#paper);
        this.circuit.on('new:paper', (paper) => { this.#registerPaper(paper); });
        this.circuit.on('userChange', () => {
            this.#updateRunStates();
        });
        this.circuit.on('changeRunning', () => {
            this.#updateRunStates();
        });
        this.#updateRunStates();
        const live_btn = $('#monitorbox vscode-button[name=live]');
        const live_btn_icon = live_btn.find('i.codicon');
        const set_live = (live) => {
            live_btn_icon.toggleClass('codicon-debug-pause', live)
                         .toggleClass('codicon-debug-start', !live);
            live_btn.prop('title', live ? 'Pause plot' : 'Live plot');
        };
        $('#monitorbox vscode-button').prop('disabled', false);
        $('#monitorbox vscode-button[name=ppt_up]').on('click', (e) => { this.#monitorview.pixelsPerTick *= 2; });
        $('#monitorbox vscode-button[name=ppt_down]').on('click', (e) => { this.#monitorview.pixelsPerTick /= 2; });
        $('#monitorbox vscode-button[name=left]').on('click', (e) => {
            this.#monitorview.live = false;
            this.#monitorview.start -= this.#monitorview.width / this.#monitorview.pixelsPerTick / 4;
        });
        $('#monitorbox vscode-button[name=right]').on('click', (e) => {
            this.#monitorview.live = false;
            this.#monitorview.start += this.#monitorview.width / this.#monitorview.pixelsPerTick / 4;
        });
        set_live(this.#monitorview.live);
        live_btn.on('click', (e) => {
            this.#monitorview.live = !this.#monitorview.live;
            if (this.#monitorview.live)
                this.#monitorview.start = this.circuit.tick - this.#monitorview.width / this.#monitorview.pixelsPerTick;
        });
        this.#monitorview.on('change:live', set_live);
        this.#monitor.on('add', () => {
            if ($('#monitorbox').height() == 0)
                $('html > body > div').css('grid-template-rows', (idx, old) => {
                    const z = old.split(' ');
                    z[0] = '3fr';
                    z[2] = '1fr';
                    return z.join(' ');
                });
        });
        const show_range = () => {
            $('#monitorbox vscode-text-field[name=rangel]').val(Math.round(this.#monitorview.start));
            $('#monitorbox vscode-text-field[name=rangeh]').val(Math.round(this.#monitorview.start + this.#monitorview.width / this.#monitorview.pixelsPerTick));
        };
        const show_scale = () => {
            $('#monitorbox vscode-text-field[name=scale]').val(this.#monitorview.gridStep);
        };
        show_range();
        show_scale();
        this.#monitorview.on('change:start', show_range);
        this.#monitorview.on('change:pixelsPerTick', show_scale);

        this.#restoreStates(old_states, opts.keep);
    }

    #updateRunStates() {
        const circuit = this.circuit;
        if (circuit === undefined) {
            vscode.postMessage({ command: "runstate", hascircuit: false,
                                 running: false, pendingEvents: false });
            return;
        }
        vscode.postMessage({ command: "runstate", hascircuit: true,
                             running: circuit.running,
                             pendingEvents: circuit.hasPendingEvents });
        this.#monitorview.autoredraw = !circuit.running;
    }
    #destroyCircuit() {
        this.#paper_in_flight.clear();
        if (this.#monitor) {
            // remember which signals were monitored
            this.#monitormem = this.#monitor.getWiresDesc();
        }
        if (this.circuit) {
            this.circuit.shutdown();
            this.circuit = undefined;
            this.#subcircuit_tracker.clear();
        }
        if (this.#paper) {
            this.#paper.remove();
            this.#paper = undefined;
        }
        if (this.#monitorview) {
            this.#monitorview.shutdown();
            this.#monitorview = undefined;
        }
        if (this.#monitor) {
            this.#monitor.stopListening();
            this.#monitor = undefined;
        }
        if (this.#iopanel) {
            this.#iopanel.shutdown();
            this.#iopanel = undefined;
        }
        this.#lua.shutdown();
        this.#updateRunStates();
        $('#monitorbox vscode-button').prop('disabled', true).off();
        $('#paper').empty();
    }
    #pauseSim() {
        this.circuit.stop();
    }
    #startSim() {
        this.circuit.start();
    }
    #singleStepSim() {
        this.circuit.updateGates();
        this.#updateRunStates();
    }
    #nextEventSim() {
        this.circuit.updateGatesNext();
        this.#updateRunStates();
    }
    #fastForwardSim() {
        this.circuit.startFast();
        this.#updateRunStates();
    }
}

new DigitalJS();
