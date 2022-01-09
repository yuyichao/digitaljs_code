//

'use strict';

import './scss/app.scss';
import $ from 'jquery';
import * as digitaljs from 'digitaljs';
import * as digitaljs_lua from 'digitaljs_lua';
import Split from 'split-grid';
import { MonitorView } from './monitor.mjs';
import { RemoteIOPanel } from './iopanel.mjs';

const vscode = acquireVsCodeApi();

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
    constructor(djs) {
        this.djs = djs;
        this.runners = {};
    }

    _error(name, e) {
        vscode.postMessage({ command: "luaerror", name, message: e.luaMessage });
    }
    _getRunner(name) {
        let runner = this.runners[name];
        if (runner)
            return runner;
        runner = new digitaljs_lua.LuaRunner(this.djs.circuit);
        runner.on('thread:stop', (pid) => {
            vscode.postMessage({ command: "luastop", name });
        });
        runner.on('thread:error', (pid, e) => {
            this._error(name, e);
        });
        runner.on('print', msgs => {
            vscode.postMessage({ command: "luaprint", name, messages: msgs });
        });
        this.runners[name] = runner;
        return runner;
    }
    run(name, script) {
        this.stop(name);
        const runner = this._getRunner(name);
        let pid;
        try {
            pid = runner.runThread(script);
            runner.running_pid = pid;
        }
        catch (e) {
            if (e instanceof digitaljs_lua.LuaError) {
                this._error(name, e);
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
        const helper = this.runners[name];
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
        for (const h of Object.values(this.runners))
            h.shutdown();
        this.runners = {};
    }
}

class DigitalJS {
    constructor() {
        this.circuit = undefined;
        this.monitor = undefined;
        this.monitormem = undefined;
        this.monitorview = undefined;
        this.paper = undefined;
        this.lua = new LuaRunner(this);
        window.addEventListener('message', event => {
            this.processMessage(event.data);
        });
        $(window).on('load', () => this.initialize());
    }

    initialize() {
        Split({
            rowGutters: [{
                element: document.querySelector('#gutter_vert'),
                track: 1
            }]
        });
        this.updateRunStates();
        $('#monitorbox vscode-button').prop('disabled', true).off();
        // Release the messages from the main extension
        // (though the run state update should've already realeased it...)
        vscode.postMessage({ command: 'initialized' });
    }

    async processMessage(message) {
        if (message.command.startsWith('iopanel:')) {
            if (this.iopanel)
                this.iopanel.processMessage(message);
            return;
        }
        switch (message.command) {
            case 'showcircuit':
                this.mkCircuit(message.circuit, message.opts);
                return;
            case 'savecircuit':
                vscode.postMessage({ command: "updatecircuit",
                                     circuit: this.circuit.toJSON() });
                return;
            case 'pausesim':
                this.pauseSim();
                return;
            case 'startsim':
                this.startSim();
                return;
            case 'singlestepsim':
                this.singleStepSim();
                return;
            case 'nexteventsim':
                this.nextEventSim();
                return;
            case 'fastforwardsim':
                this.fastForwardSim();
                return;
            case 'runlua':
                this.lua.run(message.name, message.script);
                return;
            case 'stoplua':
                this.lua.stopLua(message.name);
                return;
        }
    }

    registerMarkers(paper) {
        paper.on('cell:mouseover', (cellView) => {
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
        });
        paper.on('cell:mouseout', (cellView) => {
            vscode.postMessage({ command: "clearmarker" });
        });
    }
    mkCircuit(data, opts) {
        if (opts.transform)
            data = digitaljs.transform.transformCircuit(data);
        this.destroyCircuit();
        if (circuit_empty(data))
            return;
        const circuit_opts = {
            layoutEngine: 'elkjs',
            engine: digitaljs.engines.WorkerEngine,
            engineOptions: { workerURL: window.simWorkerUri }
        };
        this.circuit = new digitaljs.Circuit(data, circuit_opts);
        this.circuit.on('postUpdateGates', (tick) => {
            vscode.postMessage({ command: "tick", tick });
        });
        if (!opts.pause)
            this.circuit.start();
        this.monitor = new digitaljs.Monitor(this.circuit);
        if (this.monitormem) {
            this.monitor.loadWiresDesc(this.monitormem);
            this.monitormem = undefined;
        }
        this.monitorview = new MonitorView({ model: this.monitor, el: $('#monitor') });
        this.iopanel = new RemoteIOPanel({
            model: this.circuit, el: $(''), djs: this, vscode: vscode
        });
        this.paper = this.circuit.displayOn($('<div>').appendTo($('#paper')));
        this.registerMarkers(this.paper);
        this.circuit.on('new:paper', (paper) => { this.registerMarkers(paper); });
        this.circuit.on('userChange', () => {
            this.updateRunStates();
        });
        this.circuit.on('changeRunning', () => {
            this.updateRunStates();
        });
        this.updateRunStates();
        const live_btn = $('#monitorbox vscode-button[name=live]');
        const live_btn_icon = live_btn.find('i.codicon');
        const set_live = (live) => {
            live_btn_icon.toggleClass('codicon-debug-pause', live)
                         .toggleClass('codicon-debug-start', !live);
            live_btn.prop('title', live ? 'Pause plot' : 'Live plot');
        };
        $('#monitorbox vscode-button').prop('disabled', false);
        $('#monitorbox vscode-button[name=ppt_up]').on('click', (e) => { this.monitorview.pixelsPerTick *= 2; });
        $('#monitorbox vscode-button[name=ppt_down]').on('click', (e) => { this.monitorview.pixelsPerTick /= 2; });
        $('#monitorbox vscode-button[name=left]').on('click', (e) => {
            this.monitorview.live = false;
            this.monitorview.start -= this.monitorview.width / this.monitorview.pixelsPerTick / 4;
        });
        $('#monitorbox vscode-button[name=right]').on('click', (e) => {
            this.monitorview.live = false;
            this.monitorview.start += this.monitorview.width / this.monitorview.pixelsPerTick / 4;
        });
        set_live(this.monitorview.live);
        live_btn.on('click', (e) => {
            this.monitorview.live = !this.monitorview.live;
                if (this.monitorview.live)
                    this.monitorview.start = this.circuit.tick - this.monitorview.width / this.monitorview.pixelsPerTick;
            });
        this.monitorview.on('change:live', set_live);
        this.monitor.on('add', () => {
            if ($('#monitorbox').height() == 0)
                $('html > body > div').css('grid-template-rows', (idx, old) => {
                    const z = old.split(' ');
                    z[0] = '3fr';
                    z[2] = '1fr';
                    return z.join(' ');
                });
        });
        const show_range = () => {
            $('#monitorbox vscode-text-field[name=rangel]').val(Math.round(this.monitorview.start));
            $('#monitorbox vscode-text-field[name=rangeh]').val(Math.round(this.monitorview.start + this.monitorview.width / this.monitorview.pixelsPerTick));
        };
        const show_scale = () => {
            $('#monitorbox vscode-text-field[name=scale]').val(this.monitorview.gridStep);
        };
        show_range();
        show_scale();
        this.monitorview.on('change:start', show_range);
        this.monitorview.on('change:pixelsPerTick', show_scale);
    }

    updateRunStates() {
        const circuit = this.circuit;
        if (circuit === undefined) {
            vscode.postMessage({ command: "runstate", hascircuit: false,
                                 running: false, pendingEvents: false });
            return;
        }
        vscode.postMessage({ command: "runstate", hascircuit: true,
                             running: circuit.running,
                             pendingEvents: circuit.hasPendingEvents });
        this.monitorview.autoredraw = !circuit.running;
    }
    destroyCircuit() {
        if (this.monitor) {
            // remember which signals were monitored
            this.monitormem = this.monitor.getWiresDesc();
        }
        if (this.circuit) {
            this.circuit.shutdown();
            this.circuit = undefined;
        }
        if (this.paper) {
            this.paper.remove();
            this.paper = undefined;
        }
        if (this.monitorview) {
            this.monitorview.shutdown();
            this.monitorview = undefined;
        }
        if (this.monitor) {
            this.monitor.stopListening();
            this.monitor = undefined;
        }
        if (this.iopanel) {
            this.iopanel.shutdown();
            this.iopanel = undefined;
        }
        this.lua.shutdown();
        this.updateRunStates();
        $('#monitorbox vscode-button').prop('disabled', true).off();
    }
    pauseSim() {
        this.circuit.stop();
    }
    startSim() {
        this.circuit.start();
    }
    singleStepSim() {
        this.circuit.updateGates();
        this.updateRunStates();
    }
    nextEventSim() {
        this.circuit.updateGatesNext();
        this.updateRunStates();
    }
    fastForwardSim() {
        this.circuit.startFast();
        this.updateRunStates();
    }
}

new DigitalJS();
