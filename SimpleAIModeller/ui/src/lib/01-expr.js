// =======================================================================
//  01 - Espressioni numeriche (niente eval)
//
//  Un valore della spec e' un numero oppure una stringa tipo "h*0.5+t".
//  Si valuta con shunting-yard: tokenizer -> RPN -> stack. Niente `eval`,
//  niente `Function()`: un identificatore sconosciuto e' 0, non un
//  ReferenceError che ammazza il bootstrap.
//
//  Funzioni e costanti devono restare allineate a `EXPR_FUNCS`/`EXPR_CONSTS`
//  in SimpleAIModeller/src/spec.py: il server le usa per avvisare dei
//  parametri ignoti, qui per calcolare. Un test di parita' le confronta.
// =======================================================================

const EXPR_CONSTS = {
    PI: Math.PI,
    TAU: Math.PI * 2,
    E: Math.E,
    SQRT2: Math.SQRT2,
};

const EXPR_FUNCS = {
    min: Math.min,
    max: Math.max,
    abs: Math.abs,
    sqrt: Math.sqrt,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    sign: Math.sign,
    pow: Math.pow,
    mod: (a, b) => a % b,
    clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    lerp: (a, b, t) => a + (b - a) * t,
};

const EXPR_PREC = {
    '+': 1, '-': 1,
    '*': 2, '/': 2, '%': 2,
    'u-': 3, 'u+': 3,       // unari
    '^': 4,
};

function exprTokenize(src) {
    const s = String(src);
    const out = [];
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
        if ((c >= '0' && c <= '9') || (c === '.' && i + 1 < s.length && s[i + 1] >= '0' && s[i + 1] <= '9')) {
            let j = i + 1;
            while (j < s.length && ((s[j] >= '0' && s[j] <= '9') || s[j] === '.' || s[j] === 'e' || s[j] === 'E')) {
                if ((s[j] === 'e' || s[j] === 'E') && j + 1 < s.length && (s[j + 1] === '+' || s[j + 1] === '-')) j++;
                j++;
            }
            out.push({ t: 'num', v: parseFloat(s.slice(i, j)) });
            i = j;
            continue;
        }
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
            let j = i + 1;
            while (j < s.length && ((s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= 'a' && s[j] <= 'z')
                    || (s[j] >= '0' && s[j] <= '9') || s[j] === '_')) j++;
            out.push({ t: 'id', v: s.slice(i, j) });
            i = j;
            continue;
        }
        if (c === ',' || c === '(' || c === ')') {
            out.push({ t: c });
            i++;
            continue;
        }
        if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '^') {
            out.push({ t: 'op', v: c });
            i++;
            continue;
        }
        // Carattere ignoto: si salta invece di far fallire tutta l'espressione.
        i++;
    }
    return out;
}

function exprToRpn(tokens) {
    const out = [];
    const ops = [];
    let prev = null;        // per distinguere unario da binario
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.t === 'num') {
            out.push(tok);
            prev = 'val';
        } else if (tok.t === 'id') {
            // funzione se seguita da '('
            if (i + 1 < tokens.length && tokens[i + 1].t === '(') {
                ops.push({ t: 'fn', v: tok.v });
            } else {
                out.push(tok);
            }
            prev = 'val';
        } else if (tok.t === ',') {
            while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
            prev = 'sep';
        } else if (tok.t === 'op') {
            let op = tok.v;
            if ((prev === null || prev === 'op' || prev === 'sep' || prev === '(')
                    && (op === '-' || op === '+')) {
                op = 'u' + op;
            }
            const prec = EXPR_PREC[op] || 0;
            const right = (op === '^' || op === 'u-' || op === 'u+');
            while (ops.length) {
                const top = ops[ops.length - 1];
                if (top.t !== 'op') break;
                const tp = EXPR_PREC[top.v] || 0;
                if (right ? tp > prec : tp >= prec) out.push(ops.pop());
                else break;
            }
            ops.push({ t: 'op', v: op });
            prev = 'op';
        } else if (tok.t === '(') {
            ops.push(tok);
            prev = '(';
        } else if (tok.t === ')') {
            while (ops.length && ops[ops.length - 1].t !== '(') out.push(ops.pop());
            if (ops.length && ops[ops.length - 1].t === '(') ops.pop();
            if (ops.length && ops[ops.length - 1].t === 'fn') out.push(ops.pop());
            prev = 'val';
        }
    }
    while (ops.length) {
        const t = ops.pop();
        if (t.t !== '(') out.push(t);
    }
    return out;
}

function exprEvalRpn(rpn, params) {
    const st = [];
    for (let i = 0; i < rpn.length; i++) {
        const tok = rpn[i];
        if (tok.t === 'num') {
            st.push(tok.v);
        } else if (tok.t === 'id') {
            if (Object.prototype.hasOwnProperty.call(EXPR_CONSTS, tok.v)) {
                st.push(EXPR_CONSTS[tok.v]);
            } else if (params && Object.prototype.hasOwnProperty.call(params, tok.v)) {
                const p = params[tok.v];
                st.push(typeof p === 'number' ? p : Number(p) || 0);
            } else {
                st.push(0);
            }
        } else if (tok.t === 'fn') {
            const fn = EXPR_FUNCS[tok.v];
            if (!fn) { st.push(0); continue; }
            // Arity: si prende il minimo fra la lunghezza della funzione e lo stack.
            // clamp/lerp/pow/min/max hanno 2-3 args; abs/sin/... ne hanno 1.
            let n = fn.length;
            if (tok.v === 'min' || tok.v === 'max') n = Math.min(2, st.length);
            if (n > st.length) n = st.length;
            const args = st.splice(st.length - n, n);
            const r = fn.apply(null, args);
            st.push(typeof r === 'number' && isFinite(r) ? r : 0);
        } else if (tok.t === 'op') {
            if (tok.v === 'u-') {
                st.push(-(st.pop() || 0));
            } else if (tok.v === 'u+') {
                st.push(+(st.pop() || 0));
            } else {
                const b = st.pop() || 0;
                const a = st.pop() || 0;
                let r = 0;
                if (tok.v === '+') r = a + b;
                else if (tok.v === '-') r = a - b;
                else if (tok.v === '*') r = a * b;
                else if (tok.v === '/') r = b === 0 ? 0 : a / b;
                else if (tok.v === '%') r = b === 0 ? 0 : a % b;
                else if (tok.v === '^') r = Math.pow(a, b);
                st.push(isFinite(r) ? r : 0);
            }
        }
    }
    const r = st.length ? st[st.length - 1] : 0;
    return (typeof r === 'number' && isFinite(r)) ? r : 0;
}

const _exprCache = new Map();

function evalExpr(value, params) {
    if (typeof value === 'number') return isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return 0;
    const s = String(value).trim();
    if (!s) return 0;
    // Numero puro: non passa dal parser.
    const asNum = Number(s);
    if (s !== '' && isFinite(asNum) && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
        return asNum;
    }
    let rpn = _exprCache.get(s);
    if (!rpn) {
        rpn = exprToRpn(exprTokenize(s));
        if (_exprCache.size > 500) _exprCache.clear();
        _exprCache.set(s, rpn);
    }
    return exprEvalRpn(rpn, params || {});
}

function evalVec3(value, params, fallback) {
    fallback = fallback || [0, 0, 0];
    if (value == null) return fallback.slice();
    if (typeof value === 'number' || typeof value === 'string') {
        const s = evalExpr(value, params);
        return [s, s, s];
    }
    if (Array.isArray(value)) {
        return [
            evalExpr(value[0] != null ? value[0] : fallback[0], params),
            evalExpr(value[1] != null ? value[1] : fallback[1], params),
            evalExpr(value[2] != null ? value[2] : fallback[2], params),
        ];
    }
    if (typeof value === 'object') {
        return [
            evalExpr(value.x != null ? value.x : (value[0] != null ? value[0] : fallback[0]), params),
            evalExpr(value.y != null ? value.y : (value[1] != null ? value[1] : fallback[1]), params),
            evalExpr(value.z != null ? value.z : (value[2] != null ? value[2] : fallback[2]), params),
        ];
    }
    return fallback.slice();
}
