//

'use strict';

import './scss/app.scss';
import $ from 'jquery';
import * as digitaljs from 'digitaljs';
import * as digitaljs_lua from 'digitaljs_lua';
import svgPanZoom from 'svg-pan-zoom';
import * as imgutils from './imgutils.mjs';
import Split from 'split-grid';
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

class DigitalJS {
    #iopanel
    #monitor
    #monitormem
    #monitorview
    #paper
    #lua
    #change_tracker
    #subcircuit_tracker
    constructor() {
        this.circuit = undefined;
        this.#lua = new LuaRunner(this);
        this.#change_tracker = new ChangeTracker();
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
                    try {
                        if (message.type == 'image/svg+xml') {
                            const svg = imgutils.toSvg(ele);
                            return post_reply(svg, false);
                        }
                        const canvas = await imgutils.toCanvas(ele);
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

    #registerMarkers(paper) {
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

        let currentScale = 1;

        const panAndZoom = svgPanZoom(paper.svg, {
            fit: false,
            center: false,
            dblClickZoomEnabled: false,
            mouseWheelZoomEnabled: true,
            zoomScaleSensitivity: 0.2,
            panEnabled: false,
            zoomEnabled: true,
            mouseWheelEventFilter: (evt) => {
                return (evt.ctrlKey || evt.metaKey) && !evt.shiftKey && !evt.altKey;
            },
            onZoom: function(scale) {
                currentScale = scale;
            }
        });

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
    #mkCircuit(data, opts) {
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
        this.#destroyCircuit();
        if (circuit_empty(data))
            return;
        const circuit_opts = {
            layoutEngine: 'elkjs',
            engine: digitaljs.engines.WorkerEngine,
            engineOptions: { workerURL: window.simWorkerUri },
            windowCallback: (type, div, close_cb, ...args) => {
                let id;
                if (type !== "Memory") {
                    const title = div.attr('title') || 'unknown subcircuit';
                    const svg = div.find('svg');
                    id = this.#subcircuit_tracker.add(title, svg[0], type);
                }
                return this.circuit._defaultWindowCallback(type, div, () => {
                    if (id !== undefined)
                        this.#subcircuit_tracker.remove(id);
                    close_cb();
                }, ...args);
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
        this.circuit.listenTo(this.circuit._graph, 'elkjs:layout_start', (ele) => {
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
        });
        this.circuit.listenTo(this.circuit._graph, 'elkjs:layout_end', (ele) => {
            vscode.postMessage({ command: "autolayout", circuit: this.circuit.toJSON() });
            in_layout = false;
        });
        this.circuit.listenTo(this.circuit._graph, 'change:position', (ele) => {
            if (in_layout)
                return;
            this.#checkAndQueueChange(ele, 'pos');
        });
        this.circuit.listenTo(this.circuit._graph, 'change:vertices', (ele) => {
            if (in_layout)
                return;
            this.#checkAndQueueChange(ele, 'vert');
        });
        this.circuit.listenTo(this.circuit._graph, 'change:source', (ele) => {
            if (in_layout)
                return;
            this.#checkAndQueueChange(ele, 'src');
        });
        this.circuit.listenTo(this.circuit._graph, 'change:target', (ele) => {
            if (in_layout)
                return;
            this.#checkAndQueueChange(ele, 'tgt');
        });
        this.circuit.listenTo(this.circuit._graph, 'add', (ele, cells) => {
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
        this.circuit.listenTo(this.circuit._graph, 'remove', (ele, cells) => {
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
        this.circuit.listenTo(this.circuit._graph, 'batch:stop', (data) => {
            if (in_layout)
                return;
            const batch_name = data.batchName;
            // These events marks the end of a drag-and-move event
            // Out of the events that I've observed, we do not want to handle the
            // translation batch since it fires in the middle of dragging.
            if (batch_name === 'vertex-move' || batch_name == 'vertex-add' ||
                batch_name == 'pointer') {
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
        })
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
        this.#registerMarkers(this.#paper);
        this.circuit.on('new:paper', (paper) => { this.#registerMarkers(paper); });
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
