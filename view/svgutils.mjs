//

'use strict';

function get_content_rect(svg) {
    const svgrect = svg.getBoundingClientRect();
    // jointjs's paper size is larger than the content size,
    // first figure out the content size and offset.
    let realrect;
    for (const child of svg.children) {
        const rect = child.getBoundingClientRect();
        if (rect.width == 0 || rect.height == 0)
            continue;
        if (!realrect) {
            realrect = rect;
            continue;
        }
        const x1 = Math.min(realrect.x, rect.x);
        const x2 = Math.max(realrect.right, rect.right);
        const y1 = Math.min(realrect.y, rect.y);
        const y2 = Math.max(realrect.bottom, rect.bottom);
        realrect = new DOMRect(x1, y1, x2 - x1, y2 - y1);
    }
    if (!realrect)
        return;
    realrect.x -= svgrect.x;
    realrect.y -= svgrect.y;
    return realrect;
}

// Copied and adapted from html-to-image
function cloneNode(node, parent, in_foreign) {
    // This is the only foreign object we care about AFAICT
    if (node.tagName == 'foreignObject') {
        if (!node.classList.contains('valinput'))
            return;
        in_foreign = true;
    }

    const cloned = node.cloneNode(false);
    const children = node.childNodes;
    const nchildren = children.length;

    if (node instanceof HTMLInputElement)
        cloned.setAttribute('value', node.value)

    if (parent) {
        parent.appendChild(cloned);
    }
    else {
        // Add to the DOM temporarily to get the default style
        document.body.appendChild(cloned);
    }

    if (cloned instanceof Element)
        cloneCSSStyle(node, cloned, in_foreign);

    for (const child of children)
        cloneNode(child, cloned, in_foreign);

    if (!parent)
        document.body.removeChild(cloned);

    return cloned;
}

function cloneCSSStyle(node, cloned, in_foreign) {
    const source = window.getComputedStyle(node);
    const target_origin = window.getComputedStyle(cloned);
    const target = cloned.style

    if (!target)
        return

    const nstyles = source.length;
    for (let i = 0; i < nstyles; i++) {
        const name = source[i];
        if (name.startsWith('-')) // ignore vendor specific styles
            continue;
        if (name == 'cursor')
            continue; // doesn't matter for rendering
        const src_val = source.getPropertyValue(name);
        // For valinput, the default when rendering seems to be different
        // from when it is in the document so we'll set all the properties for it.
        if (!in_foreign && src_val == target_origin.getPropertyValue(name))
            continue;
        target.setProperty(name, src_val, source.getPropertyPriority(name));
    }
}

function svg_to_dataurl(svg) {
    const xml = new XMLSerializer().serializeToString(svg);
    const encoded = encodeURIComponent(xml);
    return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

function to_image(svg) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.crossOrigin = 'anonymous';
        img.decoding = 'sync';
        img.src = svg_to_dataurl(svg);
    });
}

function to_canvas(rect, img) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    // XXX: Hardcode pixel ratio for now.
    //      I'm not sure yet what's the best way to determine this...
    const ratio = 4;

    const canvasWidth = rect.width
    const canvasHeight = rect.height

    canvas.width = canvasWidth * ratio;
    canvas.height = canvasHeight * ratio;

    canvas.style.width = `${canvasWidth}`
    canvas.style.height = `${canvasHeight}`

    context.drawImage(img, rect.x, rect.y, rect.width, rect.height,
                      0, 0, canvas.width, canvas.height);
    return canvas;
}

export async function canvas(svg) {
    const content_rect = get_content_rect(svg);
    if (!content_rect)
        return;
    return to_canvas(content_rect, await to_image(cloneNode(svg)));
}
