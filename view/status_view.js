//

const vscode = acquireVsCodeApi();

function main() {
    const clock = document.getElementById("clock");
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'tick':
                clock.value = message.tick;
                return;
        }
    });
}

window.addEventListener("load", main);
