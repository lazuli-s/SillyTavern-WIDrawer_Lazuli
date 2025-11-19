import { event_types, eventSource, getRequestHeaders } from '../../../../script.js';
import { AutoComplete } from '../../../autocomplete/AutoComplete.js';
import { extensionNames } from '../../../extensions.js';
import { Popup } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { renderTemplateAsync } from '../../../templates.js';
import { debounce, debounceAsync, delay, download, getSortableDelay, isTrueBoolean, uuidv4 } from '../../../utils.js';
import { createNewWorldInfo, createWorldInfoEntry, deleteWIOriginalDataValue, deleteWorldInfoEntry, getFreeWorldName, getWorldEntry, loadWorldInfo, onWorldInfoChange, saveWorldInfo, selected_world_info, world_info, world_names } from '../../../world-info.js';
import { Settings, SORT, SORT_DIRECTION } from './src/Settings.js';

const NAME = new URL(import.meta.url).pathname.split('/').at(-2);
const watchCss = async()=>{
    if (new URL(import.meta.url).pathname.split('/').includes('reload')) return;
    try {
        const FilesPluginApi = (await import('../SillyTavern-FilesPluginApi/api.js')).FilesPluginApi;
        // watch CSS for changes
        const style = document.createElement('style');
        document.body.append(style);
        const path = [
            '~',
            'extensions',
            NAME,
            'style.css',
        ].join('/');
        const ev = await FilesPluginApi.watch(path);
        ev.addEventListener('message', async(/**@type {boolean}*/exists)=>{
            if (!exists) return;
            style.innerHTML = await (await FilesPluginApi.get(path)).text();
            document.querySelector(`#third-party_${NAME}-css`)?.remove();
        });
    } catch { /* empty */ }
};
watchCss();


const dom = {
    drawer: {
        /**@type {HTMLElement} */
        body: undefined,
    },
    /**@type {HTMLElement} */
    books: undefined,
    /**@type {HTMLElement} */
    editor: undefined,
    /**@type {HTMLElement} */
    activationToggle: undefined,
    order: {
        /**@type {HTMLElement} */
        toggle: undefined,
        /**@type {HTMLInputElement} */
        start: undefined,
        /**@type {HTMLInputElement} */
        step: undefined,
        direction: {
            /**@type {HTMLInputElement} */
            up: undefined,
            /**@type {HTMLInputElement} */
            down: undefined,
        },
        filter: {
            /**@type {HTMLElement} */
            root: undefined,
            /**@type {HTMLElement} */
            preview: undefined,
        },
        /**@type {{[book:string]:{[uid:string]:HTMLElement}}} */
        entries: {},
        /**@type {HTMLElement} */
        tbody: undefined,
    },
};
/**@type {{name:string, uid:string}} */
let currentEditor;

const activationBlock = document.querySelector('#wiActivationSettings');
const activationBlockParent = activationBlock.parentElement;

const entryState = function(entry) {
    if (entry.constant === true) {
        return 'constant';
    } else if (entry.vectorized === true) {
        return 'vectorized';
    } else {
        return 'normal';
    }
};
const sortEntries = (entries, sortLogic = null, sortDirection = null)=>{
    sortLogic ??= Settings.instance.sortLogic;
    sortDirection ??= Settings.instance.sortDirection;
    const x = (y)=>y.data ?? y;
    let result;
    let shouldReverse = true;
    switch (sortLogic) {
        case SORT.ALPHABETICAL: {
            result = entries.toSorted((a,b)=>(x(a).comment || x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment || x(b).key.join(', ')).toLowerCase()));
            break;
        }
        case SORT.PROMPT: {
            result = entries.toSorted((a,b)=>{
                if (x(a).position > x(b).position) return 1;
                if (x(a).position < x(b).position) return -1;
                if ((x(a).depth ?? Number.MAX_SAFE_INTEGER) < (x(b).depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((x(a).depth ?? Number.MAX_SAFE_INTEGER) > (x(b).depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                if ((x(a).order ?? Number.MAX_SAFE_INTEGER) > (x(b).order ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((x(a).order ?? Number.MAX_SAFE_INTEGER) < (x(b).order ?? Number.MAX_SAFE_INTEGER)) return -1;
                return (x(a).comment ?? x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment ?? x(b).key.join(', ')).toLowerCase());
            });
            break;
        }
        case SORT.ORDER: {
            shouldReverse = false;
            result = entries.toSorted((a,b)=>{
                const getOrder = (entry)=>Number.isFinite(entry.order) ? entry.order : null;
                const oa = getOrder(x(a));
                const ob = getOrder(x(b));
                const direction = sortDirection == SORT_DIRECTION.DESCENDING ? -1 : 1;
                if (oa !== null && ob !== null && oa !== ob) {
                    return direction * (oa - ob);
                }
                if (oa !== null && ob === null) return -1;
                if (oa === null && ob !== null) return 1;
                return (x(a).comment ?? x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment ?? x(b).key.join(', ')).toLowerCase());
            });
            break;
        }
        case SORT.UID: {
            shouldReverse = false;
            result = entries.toSorted((a,b)=>{
                const direction = sortDirection == SORT_DIRECTION.DESCENDING ? -1 : 1;
                const ua = Number(x(a).uid);
                const ub = Number(x(b).uid);
                const hasUa = Number.isFinite(ua);
                const hasUb = Number.isFinite(ub);
                if (hasUa && hasUb && ua !== ub) {
                    return direction * (ua - ub);
                }
                if (hasUa && !hasUb) return -1;
                if (!hasUa && hasUb) return 1;
                return (x(a).comment ?? x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment ?? x(b).key.join(', ')).toLowerCase());
            });
            break;
        }
        default: {
            result = [...entries];
            break;
        }
    }
    if (shouldReverse && sortDirection == SORT_DIRECTION.DESCENDING) result.reverse();
    return result;
};

const sortEntriesIfNeeded = (name)=>{
    const sorted = sortEntries(Object.values(cache[name].entries));
    let needsSort = false;
    let i = 0;
    for (const e of sorted) {
        if (cache[name].dom.entryList.children[i] != cache[name].dom.entry[e.uid].root) {
            needsSort = true;
            break;
        }
        i++;
    }
    if (needsSort) {
        for (const e of sorted) {
            cache[name].dom.entryList.append(cache[name].dom.entry[e.uid].root);
        }
    }
};

const cache = {};
const updateSettingsChange = ()=>{
    console.log('[STWID]', '[UPDATE-SETTINGS]');
    for (const [name, world] of Object.entries(cache)) {
        const active = selected_world_info.includes(name);
        if (world.dom.active.checked != active) {
            world.dom.active.checked = active;
        }
    }
};
let updateWIChangeStarted = Promise.withResolvers();
/**@type {PromiseWithResolvers<any>} */
let updateWIChangeFinished;
const updateWIChange = async(name = null, data = null)=>{
    console.log('[STWID]', '[UPDATE-WI]', name, data);
    updateWIChangeFinished = Promise.withResolvers();
    updateWIChangeStarted.resolve();
    // removed books
    for (const [n, w] of Object.entries(cache)) {
        if (world_names.includes(n)) continue;
        else {
            w.dom.root.remove();
            delete cache[n];
        }
    }
    // added books
    for (const name of world_names) {
        if (cache[name]) continue;
        else {
            const before = Object.keys(cache).find(it=>it.toLowerCase().localeCompare(name.toLowerCase()) == 1);
            cache[name] = { entries:{} };
            const data = await loadWorldInfo(name);
            for (const [k,v] of Object.entries(data.entries)) {
                cache[name].entries[k] = structuredClone(v);
            }
            renderBook(name, before ? cache[before].dom.root : null);
        }
    }
    if (name && cache[name]) {
        const world = { entries:{} };
        for (const [k,v] of Object.entries(data.entries)) {
            world.entries[k] = structuredClone(v);
        }
        // removed entries
        for (const e of Object.keys(cache[name].entries)) {
            if (world.entries[e]) continue;
            cache[name].dom.entry[e].root.remove();
            delete cache[name].dom.entry[e];
            delete cache[name].entries[e];
            if (currentEditor?.name == name && currentEditor?.uid == e) {
                currentEditor = null;
                dom.editor.innerHTML = '';
            }
        }
        // added entries
        const alreadyAdded = [];
        for (const e of Object.keys(world.entries)) {
            if (cache[name].entries[e]) continue;
            let a = world.entries[e];
            const sorted = sortEntries([...Object.values(cache[name].entries), ...alreadyAdded, a]);
            const before = sorted.find((it,idx)=>idx > sorted.indexOf(a));
            await renderEntry(a, name, before ? cache[name].dom.entry[before.uid].root : null);
            alreadyAdded.push(a);
        }
        // updated entries
        let hasUpdate = false;
        for (const [e,o] of Object.entries(cache[name].entries)) {
            const n = world.entries[e];
            let hasChange = false;
            for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
                if (o[k] == n[k]) continue;
                if (typeof o[k] == 'object' && JSON.stringify(o[k]) == JSON.stringify(n[k])) continue;
                hasChange = true;
                hasUpdate = true;
                switch (k) {
                    case 'content': {
                        if (currentEditor?.name == name && currentEditor?.uid == e && dom.editor.querySelector('[name="content"]').value != n.content) {
                            cache[name].dom.entry[e].root.click();
                        }
                        break;
                    }
                    case 'comment': {
                        if (currentEditor?.name == name && currentEditor?.uid == e && dom.editor.querySelector('[name="comment"]').value != n.comment) {
                            cache[name].dom.entry[e].root.click();
                        }
                        cache[name].dom.entry[e].comment.textContent = n.comment;
                        break;
                    }
                    case 'key': {
                        if (hasChange && currentEditor?.name == name && currentEditor?.uid == e) {
                            const inp = /**@type {HTMLTextAreaElement}*/(dom.editor.querySelector(`textarea[name="${k}"]`));
                            if (!inp || inp.value != n[k].join(', ')) {
                                cache[name].dom.entry[e].root.click();
                            }
                        }
                        cache[name].dom.entry[e].key.textContent = n.key.join(', ');
                        break;
                    }
                    case 'disable': {
                        if (hasChange && currentEditor?.name == name && currentEditor?.uid == e) {
                            cache[name].dom.entry[e].root.click();
                        }
                        cache[name].dom.entry[e].isEnabled.classList[n[k] ? 'remove' : 'add']('fa-toggle-on');
                        cache[name].dom.entry[e].isEnabled.classList[n[k] ? 'add' : 'remove']('fa-toggle-off');
                        break;
                    }
                    case 'constant':
                    case 'vectorized': {
                        if (hasChange && currentEditor?.name == name && currentEditor?.uid == e) {
                            cache[name].dom.entry[e].root.click();
                        }
                        cache[name].dom.entry[e].strategy.value = entryState(n);
                        break;
                    }
                    default: {
                        if (hasChange && currentEditor?.name == name && currentEditor?.uid == e) {
                            const inp = /**@type {HTMLInputElement}*/(dom.editor.querySelector(`[name="${k}"]`));
                            if (!inp || inp.value != n[k]) {
                                cache[name].dom.entry[e].root.click();
                            }
                        }
                        break;
                    }
                }
            }
        }
        cache[name].entries = world.entries;
        if (hasUpdate) {
            sortEntriesIfNeeded(name);
        }
    }
    updateWIChangeStarted = Promise.withResolvers();
    updateWIChangeFinished.resolve();
};
const updateWIChangeDebounced = debounce(updateWIChange);

const fillEmptyTitlesWithKeywords = async(name)=>{
    const data = await loadWorldInfo(name);
    let hasUpdates = false;
    for (const entry of Object.values(data.entries)) {
        const hasTitle = Boolean(entry.comment?.trim());
        if (hasTitle) continue;
        const keywords = Array.isArray(entry.key) ? entry.key.map(it=>it?.trim()).filter(Boolean) : [];
        if (keywords.length === 0) continue;
        entry.comment = keywords.join(', ');
        hasUpdates = true;
    }
    if (!hasUpdates) return;
    await saveWorldInfo(name, data, true);
    updateWIChange(name, data);
};

eventSource.on(event_types.WORLDINFO_UPDATED, (name, world)=>updateWIChangeDebounced(name, world));
eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, ()=>updateSettingsChange());


export const jumpToEntry = async(name, uid)=>{
    if (dom.activationToggle.classList.contains('stwid--active')) {
        dom.activationToggle.click();
    }
    if (dom.order.toggle.classList.contains('stwid--active')) {
        dom.order.toggle.click();
    }
    cache[name].dom.entryList.classList.remove('stwid--isCollapsed');
    cache[name].dom.collapseToggle.classList.add('fa-chevron-up');
    cache[name].dom.collapseToggle.classList.remove('fa-chevron-down');
    cache[name].dom.entry[uid].root.scrollIntoView({ block:'center', inline:'center' });
    if (currentEditor?.name != name || currentEditor?.uid != uid) {
        cache[name].dom.entry[uid].root.click();
    }
};

const renderOrderHelper = (book = null)=>{
    dom.editor.innerHTML = '';
    currentEditor = null;
    if (dom.activationToggle.classList.contains('stwid--active')) {
        dom.activationToggle.click();
    }
    for (const cb of Object.values(cache)) {
        for (const ce of Object.values(cb.dom.entry)) {
            ce.root.classList.remove('stwid--active');
        }
    }
    dom.order.entries = {};
    dom.order.filter.root = undefined;
    dom.order.filter.preview = undefined;
    dom.order.tbody = undefined;

    const entries = sortEntries(
        Object.entries(cache)
            .filter(([name])=>selected_world_info.includes(name))
            .map(([name,data])=>Object.values(data.entries).map(it=>({ book:name, data:it })))
            .flat(),
        SORT.PROMPT,
        SORT_DIRECTION.ASCENDING,
    ).filter((entry)=>!book || entry.book === book);
    const body = document.createElement('div'); {
        body.classList.add('stwid--orderHelper');
        const actions = document.createElement('div'); {
            actions.classList.add('stwid--actions');
            const filterToggle = document.createElement('div'); {
                filterToggle.classList.add('menu_button');
                filterToggle.classList.add('fa-solid', 'fa-fw', 'fa-filter');
                filterToggle.title = 'Filter entries\n---\nOrder will only be applied to unfiltered entries';
                filterToggle.addEventListener('click', ()=>{
                    const is = dom.order.filter.root.classList.toggle('stwid--active');
                    if (is) {
                        if (entries.length) {
                            dom.order.filter.preview.textContent = JSON.stringify(Object.assign({ book:entries[0].book }, entries[0].data), null, 2);
                        }
                    }
                });
                actions.append(filterToggle);
            }
            const startLbl = document.createElement('label'); {
                startLbl.classList.add('stwid--inputWrap');
                startLbl.title = 'Starting Order (topmost entry in list)';
                startLbl.append('Start: ');
                const start = document.createElement('input'); {
                    dom.order.start = start;
                    start.classList.add('stwid--input');
                    start.classList.add('text_pole');
                    start.type = 'number';
                    start.min = '1';
                    start.max = '10000';
                    start.value = localStorage.getItem('stwid--order-start') ?? '100';
                    start.addEventListener('change', ()=>{
                        localStorage.setItem('stwid--order-start', start.value);
                    });
                    startLbl.append(start);
                }
                actions.append(startLbl);
            }
            const stepLbl = document.createElement('label'); {
                stepLbl.classList.add('stwid--inputWrap');
                stepLbl.append('Spacing: ');
                const step = document.createElement('input'); {
                    dom.order.step = step;
                    step.classList.add('stwid--input');
                    step.classList.add('text_pole');
                    step.type = 'number';
                    step.min = '1';
                    step.max = '10000';
                    step.value = localStorage.getItem('stwid--order-step') ?? '10';
                    step.addEventListener('change', ()=>{
                        localStorage.setItem('stwid--order-step', step.value);
                    });
                    stepLbl.append(step);
                }
                actions.append(stepLbl);
            }
            const dir = document.createElement('div'); {
                dir.classList.add('stwid--inputWrap');
                dir.append('Direction: ');
                const wrap = document.createElement('div'); {
                    wrap.classList.add('stwid--toggleWrap');
                    const up = document.createElement('label'); {
                        up.classList.add('stwid--inputWrap');
                        up.title = 'Start at the bottom of the list';
                        const inp = document.createElement('input'); {
                            dom.order.direction.up = inp;
                            inp.type = 'radio';
                            inp.checked = (localStorage.getItem('stwid--order-direction') ?? 'down') == 'up';
                            inp.addEventListener('click', ()=>{
                                inp.checked = true;
                                dom.order.direction.down.checked = false;
                                apply.classList.remove('fa-arrow-down-1-9');
                                apply.classList.add('fa-arrow-up-9-1');
                                localStorage.setItem('stwid--order-direction', 'up');
                            });
                            up.append(inp);
                        }
                        up.append('up');
                        wrap.append(up);
                    }
                    const down = document.createElement('label'); {
                        down.classList.add('stwid--inputWrap');
                        down.title = 'Start at the top of the list';
                        const inp = document.createElement('input'); {
                            dom.order.direction.down = inp;
                            inp.type = 'radio';
                            inp.checked = (localStorage.getItem('stwid--order-direction') ?? 'down') == 'down';
                            inp.addEventListener('click', ()=>{
                                inp.checked = true;
                                dom.order.direction.up.checked = false;
                                apply.classList.add('fa-arrow-down-1-9');
                                apply.classList.remove('fa-arrow-up-9-1');
                                localStorage.setItem('stwid--order-direction', 'down');
                            });
                            down.append(inp);
                        }
                        down.append('down');
                        wrap.append(down);
                    }
                    dir.append(wrap);
                }
                actions.append(dir);
            }
            const apply = document.createElement('div'); {
                apply.classList.add('menu_button');
                apply.classList.add('fa-solid', 'fa-fw');
                if ((localStorage.getItem('stwid--order-direction') ?? 'down') == 'up') {
                    apply.classList.add('fa-arrow-up-9-1');
                } else {
                    apply.classList.add('fa-arrow-down-1-9');
                }
                apply.title = 'Apply current sorting as Order';
                apply.addEventListener('click', async()=>{
                    const start = parseInt(dom.order.start.value);
                    const step = parseInt(dom.order.step.value);
                    const up = dom.order.direction.up.checked;
                    let order = start;
                    let rows = [...dom.order.tbody.children];
                    const books = [];
                    if (up) rows.reverse();
                    for (const tr of rows) {
                        if (tr.classList.contains('stwid--isFiltered')) continue;
                        const bookName = tr.getAttribute('data-book');
                        const uid = tr.getAttribute('data-uid');
                        if (!books.includes(bookName)) books.push(bookName);
                        cache[bookName].entries[uid].order = order;
                        /**@type {HTMLInputElement}*/(tr.querySelector('[name="order"]')).value = order.toString();
                        order += step;
                    }
                    for (const bookName of books) {
                        await saveWorldInfo(bookName, { entries:cache[bookName].entries }, true);
                    }
                });
                actions.append(apply);
            }
            body.append(actions);
        }
        const filter = document.createElement('div'); {
            dom.order.filter.root = filter;
            filter.classList.add('stwid--filter');
            const main = document.createElement('div'); {
                main.classList.add('stwid--main');
                const hint = document.createElement('div'); {
                    hint.classList.add('stwid--hint');
                    const bookContextHint = book ? `<br>Book context: <code>${book}</code> (entries are scoped to this book).` : '';
                    hint.innerHTML = `
                        Script will be called for each entry in all active books.
                        Every entry for which the script returns <code>true</code> will be kept.
                        Other entries will be filtered out.
                        <br>
                        Use <code>{{var::entry}}</code> to access the entry and its properties (look
                        right for available fields).
                        ${bookContextHint}
                    `;
                    main.append(hint);
                }
                const script = document.createElement('div'); {
                    script.classList.add('stwid--script');
                    const syntax = document.createElement('pre'); {
                        syntax.classList.add('stwid--syntax');
                        script.append(syntax);
                    }
                    const overlay = document.createElement('div'); {
                        overlay.classList.add('stwid--overlay');
                        script.append(overlay);
                    }
                    const inp = document.createElement('textarea'); {
                        const defaultFilter = '{{var::entry}}';
                        inp.classList.add('stwid--input');
                        inp.classList.add('text_pole');
                        inp.name = 'filter';
                        inp.value = localStorage.getItem('stwid--order-filter') ?? defaultFilter;
                        let filterStack = [];
                        const updateScroll = ()=>{
                            const scrollTop = inp.scrollTop;
                            syntax.scrollTop = scrollTop;
                        };
                        const updateScrollDebounced = debounce(()=>updateScroll(), 150);
                        const updateList = async()=>{
                            if (!dom.order.filter.root.classList.contains('stwid--active')) return;
                            const closure = new (await SlashCommandParser.getScope())();
                            filterStack.push(closure);
                            const clone = inp.value;
                            const script = `return async function orderHelperFilter(data) {${clone}}();`;
                            try {
                                await closure.compile(script);
                                const entries = sortEntries(
                                    Object.entries(dom.order.entries)
                                        .map(([book,entries])=>Object.values(entries).map(tr=>({
                                            book,
                                            dom:tr,
                                            data:cache[book].entries[tr.getAttribute('data-uid')],
                                        })))
                                        .flat(),
                                    SORT.PROMPT,
                                    SORT_DIRECTION.ASCENDING,
                                );
                                for (const e of entries) {
                                    dom.order.entries[e.book][e.data.uid].classList.remove('stwid--isFiltered');
                                    dom.order.entries[e.book][e.data.uid].classList.add('stwid--isFiltered');
                                }
                                for (const e of entries) {
                                    closure.scope.setVariable('entry', JSON.stringify(Object.assign({ book:e.book }, e.data)));
                                    const result = (await closure.execute()).pipe;
                                    if (filterStack.at(-1) != closure) {
                                        filterStack.splice(filterStack.indexOf(closure), 1);
                                        return;
                                    }
                                    if (isTrueBoolean(result)) {
                                        dom.order.entries[e.book][e.data.uid].classList.remove('stwid--isFiltered');
                                    } else {
                                        dom.order.entries[e.book][e.data.uid].classList.add('stwid--isFiltered');
                                    }
                                }
                                filterStack.splice(filterStack.indexOf(closure), 1);
                            } catch { /* empty */ }
                        };
                        const updateListDebounced = debounce(()=>updateList(), 1000);
                        inp.addEventListener('input', () => {
                            syntax.innerHTML = hljs.highlight(`${inp.value}${inp.value.slice(-1) == '\n' ? ' ' : ''}`, { language:'stscript', ignoreIllegals:true })?.value;
                            updateScrollDebounced();
                            updateListDebounced();
                        });
                        inp.addEventListener('scroll', ()=>{
                            updateScrollDebounced();
                        });
                        inp.style.color = 'transparent';
                        inp.style.background = 'transparent';
                        inp.style.setProperty('text-shadow', 'none', 'important');
                        syntax.innerHTML = hljs.highlight(`${inp.value}${inp.value.slice(-1) == '\n' ? ' ' : ''}`, { language:'stscript', ignoreIllegals:true })?.value;
                        script.append(inp);
                    }
                    main.append(script);
                }
                filter.append(main);
            }
            const preview = document.createElement('div'); {
                dom.order.filter.preview = preview;
                preview.classList.add('stwid--preview');
                filter.append(preview);
            }
            body.append(filter);
        }
        const wrap = document.createElement('div'); {
            wrap.classList.add('stwid--orderTableWrap');
            const tbl = document.createElement('table'); {
                tbl.classList.add('stwid--orderTable');
                const thead = document.createElement('thead'); {
                    const tr = document.createElement('tr'); {
                        for (const col of ['', '', 'Entry', 'Strat', 'Position', 'Depth', 'Order', 'Trigg %']) {
                            const th = document.createElement('th'); {
                                th.textContent = col;
                                tr.append(th);
                            }
                        }
                        thead.append(tr);
                    }
                    tbl.append(thead);
                }
                const tbody = document.createElement('tbody'); {
                    dom.order.tbody = tbody;
                    $(tbody).sortable({
                        // handle: 'stwid--sortableHandle',
                        delay: getSortableDelay(),
                    });
                    for (const e of entries) {
                        const tr = document.createElement('tr'); {
                            tr.setAttribute('data-book', e.book);
                            tr.setAttribute('data-uid', e.data.uid);
                            if (!dom.order.entries[e.book]) {
                                dom.order.entries[e.book] = {};
                            }
                            dom.order.entries[e.book][e.data.uid] = tr;
                            const handle = document.createElement('td'); {
                                const i = document.createElement('div'); {
                                    i.classList.add('stwid--sortableHandle');
                                    i.textContent = '☰';
                                    handle.append(i);
                                }
                                tr.append(handle);
                            }
                            const active = document.createElement('td'); {
                                const isEnabled = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryKillSwitch"]').cloneNode(true)); {
                                    isEnabled.classList.add('stwid--enabled');
                                    if (e.data.disable) {
                                        isEnabled.classList.toggle('fa-toggle-off');
                                        isEnabled.classList.toggle('fa-toggle-on');
                                    }
                                    isEnabled.addEventListener('click', async()=>{
                                        const dis = isEnabled.classList.toggle('fa-toggle-off');
                                        isEnabled.classList.toggle('fa-toggle-on');
                                        cache[e.book].dom.entry[e.data.uid].isEnabled.classList.toggle('fa-toggle-off');
                                        cache[e.book].dom.entry[e.data.uid].isEnabled.classList.toggle('fa-toggle-on');
                                        cache[e.book].entries[e.data.uid].disable = dis;
                                        await saveWorldInfo(e.book, { entries:cache[e.book].entries }, true);
                                    });
                                    active.append(isEnabled);
                                }
                                tr.append(active);
                            }
                            const entry = document.createElement('td'); {
                                const wrap = document.createElement('div'); {
                                    wrap.classList.add('stwid--colwrap');
                                    wrap.classList.add('stwid--entry');
                                    const bookLabel = document.createElement('div'); {
                                        bookLabel.classList.add('stwid--book');
                                        const i = document.createElement('i'); {
                                            i.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
                                            bookLabel.append(i);
                                        }
                                        const txt = document.createElement('span'); {
                                            txt.textContent = e.book;
                                            bookLabel.append(txt);
                                        }
                                        wrap.append(bookLabel);
                                    }
                                    const comment = document.createElement('div'); {
                                        comment.classList.add('stwid--comment');
                                        comment.textContent = e.data.comment;
                                        wrap.append(comment);
                                    }
                                    const key = document.createElement('div'); {
                                        key.classList.add('stwid--key');
                                        key.textContent = e.data.key.join(', ');
                                    }
                                    wrap.append(key);
                                    entry.append(wrap);
                                }
                                tr.append(entry);
                            }
                            const strategy = document.createElement('td'); {
                                const strat = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryStateSelector"]').cloneNode(true)); {
                                    strat.classList.add('stwid--strategy');
                                    strat.value = entryState(e.data);
                                    strat.addEventListener('change', async()=>{
                                        const value = strat.value;
                                        cache[e.book].dom.entry[e.data.uid].strategy.value = value;
                                        switch (value) {
                                            case 'constant': {
                                                cache[e.book].entries[e.data.uid].constant = true;
                                                cache[e.book].entries[e.data.uid].vectorized = false;
                                                break;
                                            }
                                            case 'normal': {
                                                cache[e.book].entries[e.data.uid].constant = false;
                                                cache[e.book].entries[e.data.uid].vectorized = false;
                                                break;
                                            }
                                            case 'vectorized': {
                                                cache[e.book].entries[e.data.uid].constant = false;
                                                cache[e.book].entries[e.data.uid].vectorized = true;
                                                break;
                                            }
                                        }
                                        await saveWorldInfo(e.book, { entries:cache[e.book].entries }, true);
                                    });
                                    strategy.append(strat);
                                }
                                tr.append(strategy);
                            }
                            const position = document.createElement('td'); {
                                const pos = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="position"]').cloneNode(true)); {
                                    cache[e.book].dom.entry[e.data.uid].position = pos;
                                    pos.classList.add('stwid--position');
                                    pos.value = e.data.position;
                                    pos.addEventListener('change', async()=>{
                                        const value = pos.value;
                                        cache[e.book].dom.entry[e.data.uid].position.value = value;
                                        cache[e.book].entries[e.data.uid].position = value;
                                        await saveWorldInfo(e.book, { entries:cache[e.book].entries }, true);
                                    });
                                    position.append(pos);
                                }
                                tr.append(position);
                            }
                            const depth = document.createElement('td'); {
                                const inp = document.createElement('input'); {
                                    inp.classList.add('stwid--input');
                                    inp.classList.add('text_pole');
                                    inp.name = 'depth';
                                    inp.min = '0';
                                    inp.max = '99999';
                                    inp.type = 'number';
                                    inp.value = e.data.depth ?? '';
                                    depth.append(inp);
                                }
                                tr.append(depth);
                            }
                            const order = document.createElement('td'); {
                                const inp = document.createElement('input'); {
                                    inp.classList.add('stwid--input');
                                    inp.classList.add('text_pole');
                                    inp.name = 'order';
                                    inp.min = '0';
                                    inp.max = '99999';
                                    inp.type = 'number';
                                    inp.value = e.data.order ?? '';
                                    order.append(inp);
                                }
                                tr.append(order);
                            }
                            const probability = document.createElement('td'); {
                                const inp = document.createElement('input'); {
                                    inp.classList.add('stwid--input');
                                    inp.classList.add('text_pole');
                                    inp.name = 'selective_probability';
                                    inp.min = '0';
                                    inp.max = '100';
                                    inp.type = 'number';
                                    inp.value = e.data.selective_probability ?? '';
                                    probability.append(inp);
                                }
                                tr.append(probability);
                            }
                            tbody.append(tr);
                        }
                    }
                    tbl.append(tbody);
                }
                wrap.append(tbl);
            }
            body.append(wrap);
        }
    }
    dom.editor.append(body);
};

const openOrderHelper = (book = null)=>{
    if (!dom.order.toggle) return;
    dom.order.toggle.classList.add('stwid--active');
    renderOrderHelper(book);
};


/** Last clickd/selected DOM (WI entry) @type {HTMLElement} */
let selectLast = null;
/** Name of the book to select WI entries from @type {string} */
let selectFrom = null;
/**@type {'ctrl'|'shift'} */
let selectMode = null;
/** List of selected entries (WI data) @type {{}[]} */
let selectList = null;
/** toastr reference showing selection help @type {JQuery<HTMLElement>} */
let selectToast = null;
const selectEnd = ()=>{
    selectFrom = null;
    selectMode = null;
    selectList = null;
    selectLast = null;
    if (selectToast) {
        toastr.clear(selectToast);
    }
    dom.books.classList.remove('stwid--isDragging');
    [...dom.books.querySelectorAll('.stwid--entry.stwid--isSelected')]
        .forEach(it=>{
            it.classList.remove('stwid--isSelected');
            it.removeAttribute('draggable');
            const icon = it.querySelector('.stwid--selector > .stwid--icon');
            icon.classList.add('fa-square');
            icon.classList.remove('fa-square-check');
        })
    ;
    [...dom.books.querySelectorAll('.stwid--book.stwid--isTarget')]
        .forEach(it=>{
            it.classList.remove('stwid--isTarget');
        })
    ;
};
/**
 *
 * @param {HTMLElement} entry
 */
const selectAdd = (entry)=>{
    entry.classList.add('stwid--isSelected');
    entry.setAttribute('draggable', 'true');
    const icon = entry.querySelector('.stwid--selector > .stwid--icon');
    icon.classList.remove('fa-square');
    icon.classList.add('fa-square-check');
};
const selectRemove = (entry)=>{
    entry.classList.remove('stwid--isSelected');
    entry.setAttribute('draggable', 'false');
    const icon = entry.querySelector('.stwid--selector > .stwid--icon');
    icon.classList.add('fa-square');
    icon.classList.remove('fa-square-check');
};
const renderBook = async(name, before = null, bookData = null)=>{
    const data = bookData ?? await loadWorldInfo(name);
    const world = { entries:{} };
    for (const [k,v] of Object.entries(data.entries)) {
        world.entries[k] = structuredClone(v);
    }
    world.dom = {
        /**@type {HTMLElement} */
        root: undefined,
        /**@type {HTMLElement} */
        name: undefined,
        /**@type {HTMLElement} */
        active: undefined,
        /**@type {HTMLElement} */
        entryList: undefined,
        /**@type {{ [uid:string]:{root:HTMLElement, comment:HTMLElement, key:HTMLElement}}} */
        entry: {},
    };
    cache[name] = world;
    const book = document.createElement('div'); {
        world.dom.root = book;
        book.classList.add('stwid--book');
        book.addEventListener('dragover', (evt)=>{
            if (selectFrom === null) return;
            evt.preventDefault();
            book.classList.add('stwid--isTarget');
        });
        book.addEventListener('dragleave', (evt)=>{
            if (selectFrom === null) return;
            book.classList.remove('stwid--isTarget');
        });
        book.addEventListener('drop', async(evt)=>{
            if (selectFrom === null) return;
            evt.preventDefault();
            const isCopy = evt.ctrlKey;
            if (selectFrom != name || isCopy) {
                const srcBook = await loadWorldInfo(selectFrom);
                const dstBook = await loadWorldInfo(name);
                for (const srcEntry of selectList) {
                    const uid = srcEntry.uid;
                    const oData = Object.assign({}, srcEntry);
                    delete oData.uid;
                    const dstEntry = createWorldInfoEntry(null, dstBook);
                    Object.assign(dstEntry, oData);
                    await saveWorldInfo(name, dstBook, true);
                    if (!isCopy) {
                        const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
                        if (deleted) {
                            deleteWIOriginalDataValue(srcBook, uid);
                        }
                    }
                }
                if (selectFrom != name) {
                    await saveWorldInfo(selectFrom, srcBook, true);
                    updateWIChange(selectFrom, srcBook);
                }
                updateWIChange(name, dstBook);
            }
            selectEnd();
        });
        const head = document.createElement('div'); {
            head.classList.add('stwid--head');
            let collapseToggle;
            const title = document.createElement('div'); {
                world.dom.name = title;
                title.classList.add('stwid--title');
                title.textContent = name;
                title.addEventListener('click', ()=>{
                    const is = entryList.classList.toggle('stwid--isCollapsed');
                    if (is) {
                        collapseToggle.classList.remove('fa-chevron-up');
                        collapseToggle.classList.add('fa-chevron-down');
                    } else {
                        collapseToggle.classList.add('fa-chevron-up');
                        collapseToggle.classList.remove('fa-chevron-down');
                    }
                });
                head.append(title);
            }
            const actions = document.createElement('div'); {
                actions.classList.add('stwid--actions');
                const active = document.createElement('input'); {
                    world.dom.active = active;
                    active.title = 'Globally active';
                    active.type = 'checkbox';
                    active.checked = selected_world_info.includes(name);
                    active.addEventListener('click', async()=>{
                        active.disabled = true;
                        onWorldInfoChange({ silent:'true', state:(active.checked ? 'on' : 'off') }, name);
                        active.disabled = false;
                    });
                    actions.append(active);
                }
                const add = document.createElement('div'); {
                    add.classList.add('stwid--action');
                    add.classList.add('stwid--add');
                    add.classList.add('fa-solid', 'fa-fw', 'fa-plus');
                    add.title = 'New Entry';
                    add.addEventListener('click', async()=>{
                        const data = { entries:structuredClone(cache[name].entries) };
                        const newEntry = createWorldInfoEntry(name, data);
                        cache[name].entries[newEntry.uid] = structuredClone(newEntry);
                        await renderEntry(newEntry, name);
                        cache[name].dom.entry[newEntry.uid].root.click();
                        await saveWorldInfo(name, data, true);
                    });
                    actions.append(add);
                }
                const menuTrigger = document.createElement('div'); {
                    menuTrigger.classList.add('stwid--action');
                    menuTrigger.classList.add('stwid--menuTrigger');
                    menuTrigger.classList.add('fa-solid', 'fa-fw', 'fa-ellipsis-vertical');
                    menuTrigger.addEventListener('click', ()=>{
                        menuTrigger.style.anchorName = '--stwid--ctxAnchor';
                        const blocker = document.createElement('div'); {
                            blocker.classList.add('stwid--blocker');
                            blocker.addEventListener('mousedown', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('pointerdown', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('touchstart', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('click', (evt)=>{
                                evt.stopPropagation();
                                blocker.remove();
                                menuTrigger.style.anchorName = '';
                            });
                            const menu = document.createElement('div'); {
                                menu.classList.add('stwid--menu');
                                const rename = document.createElement('div'); {
                                    rename.classList.add('stwid--item');
                                    rename.classList.add('stwid--rename');
                                    rename.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey
                                        const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
                                        sel.value = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name).value;
                                        sel.dispatchEvent(new Event('change', { bubbles:true }));
                                        await delay(500);
                                        document.querySelector('#world_popup_name_button').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-pencil');
                                        rename.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Rename Book';
                                        rename.append(txt);
                                    }
                                    menu.append(rename);
                                }
                                if (extensionNames.includes('third-party/SillyTavern-WorldInfoBulkEdit')) {
                                    const bulk = document.createElement('div'); {
                                        bulk.classList.add('stwid--item');
                                        bulk.classList.add('stwid--bulkEdit');
                                        bulk.addEventListener('click', async(evt)=>{
                                            //TODO cheeky monkey
                                            const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
                                            sel.value = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name).value;
                                            sel.dispatchEvent(new Event('change', { bubbles:true }));
                                            await delay(500);
                                            document.querySelector('.stwibe--trigger').click();
                                        });
                                        const i = document.createElement('i'); {
                                            i.classList.add('stwid--icon');
                                            i.classList.add('fa-solid', 'fa-fw', 'fa-list-check');
                                            bulk.append(i);
                                        }
                                        const txt = document.createElement('span'); {
                                            txt.classList.add('stwid--label');
                                            txt.textContent = 'Bulk Edit';
                                            bulk.append(txt);
                                        }
                                        menu.append(bulk);
                                    }
                                }
                                if (extensionNames.includes('third-party/SillyTavern-WorldInfoExternalEditor')) {
                                    const editor = document.createElement('div'); {
                                        editor.classList.add('stwid--item');
                                        editor.classList.add('stwid--externalEditor');
                                        editor.addEventListener('click', async(evt)=>{
                                            fetch('/api/plugins/wiee/editor', {
                                                method: 'POST',
                                                headers: getRequestHeaders(),
                                                body: JSON.stringify({
                                                    book: name,
                                                    command: 'code',
                                                    commandArguments: ['.'],
                                                }),
                                            });
                                        });
                                        const i = document.createElement('i'); {
                                            i.classList.add('stwid--icon');
                                            i.classList.add('fa-solid', 'fa-fw', 'fa-laptop-code');
                                            editor.append(i);
                                        }
                                        const txt = document.createElement('span'); {
                                            txt.classList.add('stwid--label');
                                            txt.textContent = 'External Editor';
                                            editor.append(txt);
                                        }
                                        menu.append(editor);
                                    }
                                }
                                const fillTitles = document.createElement('div'); {
                                    fillTitles.classList.add('stwid--item');
                                    fillTitles.classList.add('stwid--fillTitles');
                                    fillTitles.addEventListener('click', async()=>{
                                        await fillEmptyTitlesWithKeywords(name);
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-wand-magic-sparkles');
                                        fillTitles.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Fill Empty Titles';
                                        fillTitles.append(txt);
                                    }
                                    menu.append(fillTitles);
                                }
                                const orderHelper = document.createElement('div'); {
                                    orderHelper.classList.add('stwid--item');
                                    orderHelper.classList.add('stwid--orderHelper');
                                    orderHelper.addEventListener('click', ()=>{
                                        openOrderHelper(name);
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-arrow-down-wide-short');
                                        orderHelper.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Order Helper';
                                        orderHelper.append(txt);
                                    }
                                    menu.append(orderHelper);
                                }
                                const exp = document.createElement('div'); {
                                    exp.classList.add('stwid--item');
                                    exp.classList.add('stwid--export');
                                    exp.addEventListener('click', async(evt)=>{
                                        download(JSON.stringify({ entries:cache[name].entries }), name, 'application/json');
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-file-export');
                                        exp.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Export Book';
                                        exp.append(txt);
                                    }
                                    menu.append(exp);
                                }
                                const dup = document.createElement('div'); {
                                    dup.classList.add('stwid--item');
                                    dup.classList.add('stwid--duplicate');
                                    dup.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey
                                        const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
                                        sel.value = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name).value;
                                        sel.dispatchEvent(new Event('change', { bubbles:true }));
                                        await delay(500);
                                        document.querySelector('#world_duplicate').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-paste');
                                        dup.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Duplicate Book';
                                        dup.append(txt);
                                    }
                                    menu.append(dup);
                                }
                                const del = document.createElement('div'); {
                                    del.classList.add('stwid--item');
                                    del.classList.add('stwid--delete');
                                    del.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey
                                        const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
                                        sel.value = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name).value;
                                        sel.dispatchEvent(new Event('change', { bubbles:true }));
                                        await delay(500);
                                        document.querySelector('#world_popup_delete').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-trash-can');
                                        del.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Delete Book';
                                        del.append(txt);
                                    }
                                    menu.append(del);
                                }
                                blocker.append(menu);
                            }
                            document.body.append(blocker);
                        }
                    });
                    actions.append(menuTrigger);
                }
                collapseToggle = document.createElement('div'); {
                    cache[name].dom.collapseToggle = collapseToggle;
                    collapseToggle.classList.add('stwid--action');
                    collapseToggle.classList.add('stwid--collapseToggle');
                    collapseToggle.classList.add('fa-solid', 'fa-fw', 'fa-chevron-down');
                    collapseToggle.addEventListener('click', ()=>{
                        const is = entryList.classList.toggle('stwid--isCollapsed');
                        if (is) {
                            collapseToggle.classList.remove('fa-chevron-up');
                            collapseToggle.classList.add('fa-chevron-down');
                        } else {
                            collapseToggle.classList.add('fa-chevron-up');
                            collapseToggle.classList.remove('fa-chevron-down');
                        }
                    });
                    actions.append(collapseToggle);
                }
                head.append(actions);
            }
            book.append(head);
        }
        const entryList = document.createElement('div'); {
            world.dom.entryList = entryList;
            entryList.classList.add('stwid--entryList');
            entryList.classList.add('stwid--isCollapsed');
            for (const e of sortEntries(Object.values(world.entries))) {
                await renderEntry(e, name);
            }
            book.append(entryList);
        }
        if (before) before.insertAdjacentElement('beforebegin', book);
        else dom.books.append(book);
    }
    return book;
};
const renderEntry = async(e, name, before = null)=>{
    const world = cache[name];
    world.dom.entry[e.uid] = {};
    const entry = document.createElement('div'); {
        world.dom.entry[e.uid].root = entry;
        entry.classList.add('stwid--entry');
        entry.dataset.uid = e.uid;
        entry.addEventListener('selectstart', (evt)=>evt.preventDefault());
        entry.addEventListener('dragstart', (evt)=>{
            if (selectFrom === null || !selectList.includes(e)) {
                evt.preventDefault();
                return;
            }
            dom.books.classList.add('stwid--isDragging');
            evt.dataTransfer.setData('text/plain', entry.textContent);
        });
        const sel = document.createElement('div'); {
            sel.classList.add('stwid--selector');
            sel.title = 'Click to select entry';
            sel.addEventListener('click', (evt)=>{
                evt.preventDefault();
                // can only select from one book at a time
                if (selectFrom !== null && selectFrom != name) return;
                evt.stopPropagation();
                if (selectLast && evt.shiftKey) {
                    // range-select from last clicked entry
                    const start = [...world.dom.entryList.children].indexOf(selectLast);
                    const end = [...world.dom.entryList.children].indexOf(entry);
                    for (let i = Math.min(start, end); i <= end; i++) {
                        const el = world.dom.entryList.children[i];
                        const data = world.entries[el.dataset.uid];
                        if (!selectList.includes(data)) {
                            selectAdd(el);
                            selectList.push(data);
                        }
                    }
                    selectLast = entry;
                } else {
                    if (selectFrom === null) {
                        selectFrom = name;
                        selectList = [];
                        const help = document.createElement('ul'); {
                            help.classList.add('stwid--helpToast');
                            const lines = [
                                'Hold [SHIFT] while clicking to select a range of entries',
                                'Drag the selected entries onto another book to move them to that book',
                                'Hold [CTRL] while dragging entries to copy them to the targeted book',
                                'Hold [CTRL] while dragging entries onto the same book to duplicate them',
                                'Press [DEL] to delete the selected entries',
                            ];
                            for (const line of lines) {
                                const  li = document.createElement('li'); {
                                    li.textContent = line;
                                    help.append(li);
                                }
                            }
                        }
                        selectToast = toastr.info($(help), 'WorldInfo Drawer', {
                            timeOut: 0,
                            extendedTimeOut: 0,
                            escapeHtml: false,
                        });
                    }
                    // regular single select
                    if (selectList.includes(e)) {
                        selectRemove(entry);
                        selectList.splice(selectList.indexOf(e), 1);
                        if (selectLast == entry) selectLast = null;
                        if (selectList.length == 0) {
                            selectEnd();
                        }
                    } else {
                        selectAdd(entry);
                        selectList.push(e);
                        selectLast = entry;
                    }
                }
            });
            const i = document.createElement('div'); {
                i.classList.add('stwid--icon');
                i.classList.add('fa-solid', 'fa-square');
                sel.append(i);
            }
            entry.append(sel);
        }
        const body = document.createElement('div'); {
            body.classList.add('stwid--body');
            const comment = document.createElement('div'); {
                world.dom.entry[e.uid].comment = comment;
                comment.classList.add('stwid--comment');
                comment.textContent = e.comment;
                body.append(comment);
            }
            const key = document.createElement('div'); {
                world.dom.entry[e.uid].key = key;
                key.classList.add('stwid--key');
                key.textContent = e.key.join(', ');
                body.append(key);
            }
            entry.append(body);
        }
        const status = document.createElement('div'); {
            status.classList.add('stwid--status');
            status.addEventListener('click', (evt)=>{
                if (currentEditor?.name != name || currentEditor?.uid != e.uid) evt.stopPropagation();
            });
            const isEnabled = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryKillSwitch"]').cloneNode(true)); {
                world.dom.entry[e.uid].isEnabled = isEnabled;
                isEnabled.classList.add('stwid--enabled');
                if (e.disable) {
                    isEnabled.classList.toggle('fa-toggle-off');
                    isEnabled.classList.toggle('fa-toggle-on');
                }
                isEnabled.addEventListener('click', async()=>{
                    const dis = isEnabled.classList.toggle('fa-toggle-off');
                    isEnabled.classList.toggle('fa-toggle-on');
                    cache[name].entries[e.uid].disable = dis;
                    await saveWorldInfo(name, { entries:cache[name].entries }, true);
                });
                status.append(isEnabled);
            }
            const strat = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryStateSelector"]').cloneNode(true)); {
                world.dom.entry[e.uid].strategy = strat;
                strat.classList.add('stwid--strategy');
                strat.value = entryState(e);
                strat.addEventListener('change', async()=>{
                    const value = strat.value;
                    switch (value) {
                        case 'constant': {
                            cache[name].entries[e.uid].constant = true;
                            cache[name].entries[e.uid].vectorized = false;
                            break;
                        }
                        case 'normal': {
                            cache[name].entries[e.uid].constant = false;
                            cache[name].entries[e.uid].vectorized = false;
                            break;
                        }
                        case 'vectorized': {
                            cache[name].entries[e.uid].constant = false;
                            cache[name].entries[e.uid].vectorized = true;
                            break;
                        }
                    }
                    await saveWorldInfo(name, { entries:cache[name].entries }, true);
                });
                status.append(strat);
            }
            entry.append(status);
        }
        const actions = document.createElement('div'); {
            actions.classList.add('stwid--actions');
            entry.append(actions);
        }
        /**@type {string} */
        let clickToken;
        entry.addEventListener('click', async(evt)=>{
            const token = uuidv4();
            clickToken = token;
            if (selectFrom) selectEnd();
            for (const cb of Object.values(cache)) {
                for (const ce of Object.values(cb.dom.entry)) {
                    ce.root.classList.remove('stwid--active');
                }
            }
            if (dom.activationToggle.classList.contains('stwid--active')) {
                dom.activationToggle.click();
            }
            if (dom.order.toggle.classList.contains('stwid--active')) {
                dom.order.toggle.click();
            }
            entry.classList.add('stwid--active');
            dom.editor.innerHTML = '';
            const unfocus = document.createElement('div'); {
                unfocus.classList.add('stwid--unfocusToggle');
                unfocus.classList.add('menu_button');
                unfocus.classList.add('fa-solid', 'fa-fw', 'fa-compress');
                unfocus.title = 'Unfocus';
                unfocus.addEventListener('click', ()=>{
                    dom.editor.classList.toggle('stwid--focus');
                });
                dom.editor.append(unfocus);
            }
            dom.editor.append(document.createRange().createContextualFragment(await renderTemplateAsync('worldInfoKeywordHeaders')).querySelector('#WIEntryHeaderTitlesPC'));
            const editDom = (await getWorldEntry(name, { entries:cache[name].entries }, cache[name].entries[e.uid]))[0];
            $(editDom.querySelector('.inline-drawer')).trigger('inline-drawer-toggle');
            if (clickToken != token) return;
            const focusContainer = editDom.querySelector('label[for="content "] > small > span > span'); {
                const btn = document.createElement('div'); {
                    btn.classList.add('stwid--focusToggle');
                    btn.classList.add('menu_button');
                    btn.classList.add('fa-solid', 'fa-fw', 'fa-expand');
                    btn.title = 'Focus';
                    btn.addEventListener('click', ()=>{
                        dom.editor.classList.toggle('stwid--focus');
                    });
                    focusContainer.append(btn);
                }
            }
            dom.editor.append(editDom);
            currentEditor = { name, uid:e.uid };
        });
        if (before) before.insertAdjacentElement('beforebegin', entry);
        else world.dom.entryList.append(entry);
        return entry;
    }
};
const loadList = async()=>{
    dom.books.innerHTML = '';
    const books = await Promise.all(world_names.toSorted((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())).map(async(name)=>({ name, data:await loadWorldInfo(name) })));
    for (const book of books) {
        await renderBook(book.name, null, book.data);
    }
};
const loadListDebounced = debounceAsync(()=>loadList());


const addDrawer = ()=>{
    document.addEventListener('keydown', async(evt)=>{
        // only run when drawer is open
        if (document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2).closest('.stwid--body')) {
            // abort if no active selection
            if (selectFrom === null || !selectList?.length) return;
            console.log('[STWID]', evt.key);
            switch (evt.key) {
                case 'Delete': {
                    evt.preventDefault();
                    evt.stopPropagation();
                    const srcBook = await loadWorldInfo(selectFrom);
                    for (const srcEntry of selectList) {
                        const uid = srcEntry.uid;
                        const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
                        if (deleted) {
                            deleteWIOriginalDataValue(srcBook, uid);
                        }
                    }
                    await saveWorldInfo(selectFrom, srcBook, true);
                    updateWIChange(selectFrom, srcBook);
                    selectEnd();
                    break;
                }
            }
        }
    });
    document.body.classList.add('stwid--');
    const holder = document.querySelector('#wi-holder');
    const drawerContent = document.querySelector('#WorldInfo'); {
        let searchEntriesInput;
        let searchInput;
        const body = document.createElement('div'); {
            dom.drawer.body = body;
            body.classList.add('stwid--body');
            body.classList.add('stwid--isLoading');
            const list = document.createElement('div'); {
                list.classList.add('stwid--list');
                const controls = document.createElement('div'); {
                    controls.classList.add('stwid--controls');
                    const add = /**@type {HTMLElement}*/(document.querySelector('#world_create_button').cloneNode(true)); {
                        add.removeAttribute('id');
                        add.classList.add('stwid--addBook');
                        add.addEventListener('click', async()=>{
                            const startPromise = updateWIChangeStarted.promise;
                            const tempName = getFreeWorldName();
                            const finalName = await Popup.show.input('Create a new World Info', 'Enter a name for the new file:', tempName);
                            if (finalName) {
                                const created = await createNewWorldInfo(finalName, { interactive: true });
                                if (created) {
                                    await startPromise;
                                    await updateWIChangeFinished.promise;
                                    cache[finalName].dom.entryList.classList.remove('stwid--isCollapsed');
                                    cache[name].dom.collapseToggle.classList.add('fa-chevron-up');
                                    cache[name].dom.collapseToggle.classList.remove('fa-chevron-down');
                                    cache[finalName].dom.root.scrollIntoView({ block:'center', inline:'center' });
                                }
                            }
                        });
                        controls.append(add);
                    }
                    const imp = document.createElement('div'); {
                        imp.classList.add('menu_button');
                        imp.classList.add('fa-solid', 'fa-fw', 'fa-file-import');
                        imp.title = 'Import Book';
                        imp.addEventListener('click', ()=>{
                            /**@type {HTMLInputElement}*/(document.querySelector('#world_import_file')).click();
                        });
                        controls.append(imp);
                    }
                    const refresh = document.createElement('div'); {
                        refresh.classList.add('menu_button');
                        refresh.classList.add('fa-solid', 'fa-fw', 'fa-arrows-rotate');
                        refresh.title = 'Refresh';
                        refresh.addEventListener('click', async()=>{
                            dom.drawer.body.classList.add('stwid--isLoading');
                            dom.editor.innerHTML = '';
                            currentEditor = null;
                            for (const key of Object.keys(cache)) delete cache[key];
                            try {
                                await loadListDebounced();
                                searchInput?.dispatchEvent(new Event('input'));
                            } finally {
                                dom.drawer.body.classList.remove('stwid--isLoading');
                            }
                        });
                        controls.append(refresh);
                    }
                    const settings = document.createElement('div'); {
                        dom.activationToggle = settings;
                        settings.classList.add('stwid--activation');
                        settings.classList.add('menu_button');
                        settings.classList.add('fa-solid', 'fa-fw', 'fa-cog');
                        settings.title = 'Global Activation Settings';
                        settings.addEventListener('click', ()=>{
                            const is = settings.classList.toggle('stwid--active');
                            currentEditor = null;
                            if (is) {
                                dom.editor.innerHTML = '';
                                if (dom.order.toggle.classList.contains('stwid--active')) {
                                    dom.order.toggle.click();
                                }
                                for (const cb of Object.values(cache)) {
                                    for (const ce of Object.values(cb.dom.entry)) {
                                        ce.root.classList.remove('stwid--active');
                                    }
                                }
                                const h4 = document.createElement('h4'); {
                                    h4.textContent = 'Global World Info/Lorebook activation settings';
                                    dom.editor.append(h4);
                                }
                                dom.editor.append(activationBlock);
                            } else {
                                activationBlockParent.append(activationBlock);
                                dom.editor.innerHTML = '';
                            }
                        });
                        controls.append(settings);
                    }
                    const order = document.createElement('div'); {
                        dom.order.toggle = order;
                        order.classList.add('menu_button');
                        order.classList.add('fa-solid', 'fa-fw', 'fa-arrow-down-wide-short');
                        order.title = 'Order Helper\n---\nUse drag and drop to help assign an "Order" value to entries of all active books.';
                        order.addEventListener('click', ()=>{
                            const isActive = order.classList.contains('stwid--active');
                            if (isActive) {
                                order.classList.remove('stwid--active');
                                dom.editor.innerHTML = '';
                                currentEditor = null;
                                return;
                            }
                            openOrderHelper();
                        });
                        controls.append(order);
                    }
                    const sortSel = document.createElement('select'); {
                        sortSel.classList.add('text_pole');
                        sortSel.addEventListener('change', ()=>{
                            const value = JSON.parse(sortSel.value);
                            Settings.instance.sortLogic = value.sort;
                            Settings.instance.sortDirection = value.direction;
                            for (const name of Object.keys(cache)) {
                                sortEntriesIfNeeded(name);
                            }
                            Settings.instance.save();
                        });
                        const opts = [
                            ['Title ↗', SORT.ALPHABETICAL, SORT_DIRECTION.ASCENDING],
                            ['Title ↘', SORT.ALPHABETICAL, SORT_DIRECTION.DESCENDING],
                            ['Prompt ↗', SORT.PROMPT, SORT_DIRECTION.ASCENDING],
                            ['Prompt ↘', SORT.PROMPT, SORT_DIRECTION.DESCENDING],
                            ['Order ↗', SORT.ORDER, SORT_DIRECTION.ASCENDING],
                            ['Order ↘', SORT.ORDER, SORT_DIRECTION.DESCENDING],
                            ['UID ↗', SORT.UID, SORT_DIRECTION.ASCENDING],
                            ['UID ↘', SORT.UID, SORT_DIRECTION.DESCENDING],
                        ];
                        for (const [label, sort, direction] of opts) {
                            const opt = document.createElement('option'); {
                                opt.value = JSON.stringify({ sort, direction });
                                opt.textContent = label;
                                opt.selected = sort == Settings.instance.sortLogic && direction == Settings.instance.sortDirection;
                                sortSel.append(opt);
                            }
                        }
                        controls.append(sortSel);
                    }
                    list.append(controls);
                }
                const filter = document.createElement('div'); {
                    filter.classList.add('stwid--filter');
                    const search = document.createElement('input'); {
                        search.classList.add('stwid--search');
                        search.classList.add('text_pole');
                        search.type = 'search';
                        search.placeholder = 'Search books';
                        searchInput = search;
                        search.addEventListener('input', ()=>{
                            const query = search.value.toLowerCase();
                            for (const b of Object.keys(cache)) {
                                if (query.length) {
                                    const bookMatch = b.toLowerCase().includes(query);
                                    const entryMatch = searchEntriesInput.checked && Object.values(cache[b].entries).find(e=>e.comment.toLowerCase().includes(query));
                                    if (bookMatch || entryMatch) {
                                        cache[b].dom.root.classList.remove('stwid--filter-query');
                                        if (searchEntriesInput.checked) {
                                            for (const e of Object.values(cache[b].entries)) {
                                                if (bookMatch || e.comment.toLowerCase().includes(query)) {
                                                    cache[b].dom.entry[e.uid].root.classList.remove('stwid--filter-query');
                                                } else {
                                                    cache[b].dom.entry[e.uid].root.classList.add('stwid--filter-query');
                                                }
                                            }
                                        }
                                    } else {
                                        cache[b].dom.root.classList.add('stwid--filter-query');
                                    }
                                } else {
                                    cache[b].dom.root.classList.remove('stwid--filter-query');
                                    for (const e of Object.values(cache[b].entries)) {
                                        cache[b].dom.entry[e.uid].root.classList.remove('stwid--filter-query');
                                    }
                                }
                            }
                        });
                        filter.append(search);
                    }
                    const searchEntries = document.createElement('label'); {
                        searchEntries.classList.add('stwid--searchEntries');
                        searchEntries.title = 'Search through entries as well (Title/Memo)';
                        const inp = document.createElement('input'); {
                            searchEntriesInput = inp;
                            inp.type = 'checkbox';
                            inp.addEventListener('click', ()=>{
                                search.dispatchEvent(new Event('input'));
                            });
                            searchEntries.append(inp);
                        }
                        searchEntries.append('Entries');
                        filter.append(searchEntries);
                    }
                    const filterActive = document.createElement('label'); {
                        filterActive.classList.add('stwid--filterActive');
                        filterActive.title = 'Only show globally active books';
                        const inp = document.createElement('input'); {
                            inp.type = 'checkbox';
                            inp.addEventListener('click', ()=>{
                                for (const b of Object.keys(cache)) {
                                    if (inp.checked) {
                                        if (selected_world_info.includes(b)) {
                                            cache[b].dom.root.classList.remove('stwid--filter-active');
                                        } else {
                                            cache[b].dom.root.classList.add('stwid--filter-active');
                                        }
                                    } else {
                                        cache[b].dom.root.classList.remove('stwid--filter-active');
                                    }
                                }
                            });
                            filterActive.append(inp);
                        }
                        filterActive.append('Active');
                        filter.append(filterActive);
                    }
                    list.append(filter);
                }
                const books = document.createElement('div'); {
                    dom.books = books;
                    books.classList.add('stwid--books');
                    list.append(books);
                }
                body.append(list);
            }
            const editor = document.createElement('div'); {
                dom.editor = editor;
                editor.classList.add('stwid--editor');
                body.append(editor);
            }
            drawerContent.append(body);
        }
    }
    drawerContent.querySelector('h3 > span').addEventListener('click', ()=>{
        const is = document.body.classList.toggle('stwid--');
        if (!is) {
            if (dom.activationToggle.classList.contains('stwid--active')) {
                dom.activationToggle.click();
            }
        }
    });
    const moSel = new MutationObserver(()=>updateWIChangeDebounced());
    moSel.observe(document.querySelector('#world_editor_select'), { childList: true });
    const moDrawer = new MutationObserver(muts=>{
        if (drawerContent.getAttribute('style').includes('display: none;')) return;
        if (currentEditor) {
            cache[currentEditor.name].dom.entry[currentEditor.uid].root.click();
        }
    });
    moDrawer.observe(drawerContent, { attributes:true, attributeFilter:['style'] });
};
addDrawer();
loadListDebounced().then(()=>dom.drawer.body.classList.remove('stwid--isLoading'));


let isDiscord;
const checkDiscord = async()=>{
    let newIsDiscord = window.getComputedStyle(document.body).getPropertyValue('--nav-bar-width') !== '';
    if (isDiscord != newIsDiscord) {
        isDiscord = newIsDiscord;
        document.body.classList[isDiscord ? 'remove' : 'add']('stwid--nonDiscord');
    }
    setTimeout(()=>checkDiscord(), 1000);
};
checkDiscord();
