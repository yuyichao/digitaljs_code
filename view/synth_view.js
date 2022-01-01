//

const vscode = acquireVsCodeApi();

let options = vscode.getState() || window.init_options;

function notifyOption() {
    vscode.setState(options);
    vscode.postMessage({ command: "update-options" });
}

notifyOption();

function main() {
    for (const opt of ['opt', 'transform', /* 'lint', */ 'fsmexpand']) {
        const ele = document.getElementById(opt);
        ele.checked = options[opt];
        ele.addEventListener('change', () => {
            options[opt] = ele.checked;
            notifyOption();
        });
    }

    const fsm = document.getElementById("fsm");
    fsm.value = options.fsm;
    fsm.addEventListener('change', () => {
        options.fsm = fsm.value;
        notifyOption();
    });

    const synth = document.getElementById("do-synth");
    synth.addEventListener("click", () => {
        vscode.postMessage({ command: "do-synth" });
    });
}
window.addEventListener("load", main);
