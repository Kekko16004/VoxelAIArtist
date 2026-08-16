// =======================================================================
//  11 - Client HTTP verso il server locale
// =======================================================================

async function api(method, path, body) {
    const opts = { method: method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) {
        data = { error: text.slice(0, 300) };
    }
    if (!res.ok) {
        const err = new Error((data && data.error) || (res.status + ' ' + res.statusText));
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

function apiGet(path) { return api('GET', path); }
function apiPost(path, body) { return api('POST', path, body); }
function apiDelete(path, body) { return api('DELETE', path, body); }
