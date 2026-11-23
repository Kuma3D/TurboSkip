/**
 * TurboSkip — auto-regenerates AI messages until they contain the phrases you require.
 *
 * When an AI message renders, its text is checked against a configurable list
 * of required phrases. If the requirement isn't met, TurboSkip calls
 * Generate('regenerate') — the same function the chat menu's Regenerate option
 * invokes — and re-checks when that generation finishes, up to a max attempt
 * count.
 *
 * The loop is strictly serialized: it waits for any in-flight generation
 * (tracked via GENERATION_STARTED / GENERATION_STOPPED events) to fully end
 * before dispatching the next regen. CHARACTER_MESSAGE_RENDERED fires in the
 * middle of the generation pipeline, so dispatching a regen directly from
 * that handler would re-enter Generate while it is still running — which
 * splices the last message out and aborts the new generation, leaving the
 * chat with a deleted message and no reply.
 */

const MODULE_NAME = 'turboSkip';

const DEFAULT_SETTINGS = {
    enabled: false,
    // One phrase per line. Empty list disables checks (extension is a no-op).
    phrases: '',
    // 'all' = message must contain every phrase; 'any' = at least one phrase.
    matchMode: 'all',
    // Case-insensitive matching by default.
    caseSensitive: false,
    // Cap so a never-satisfiable requirement can't regenerate forever.
    maxAttempts: 3,
    // Show a toast when a message is regenerated.
    notifyOnSkip: true,
};

// ── State ────────────────────────────────────────────────────

let generationActive = false; // a generation is currently in flight
let skipLoopRunning = false;  // our serialized check-and-regen loop is active
let suppressRender = false;   // ignore render events right after a chat switch

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = extensionSettings[MODULE_NAME];
    // backfill any keys added in later versions
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = structuredClone(DEFAULT_SETTINGS[key]);
    }
    return s;
}

function tsDebug(...args) {
    console.debug('[TurboSkip]', ...args);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ── Phrase checking ───────────────────────────────────────────

/**
 * Get the configured phrase list as an array of trimmed, non-empty strings.
 * @returns {string[]}
 */
function getPhraseList() {
    const settings = getSettings();
    return String(settings.phrases || '')
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);
}

/**
 * Check whether message text satisfies the configured phrase requirement.
 * @param {string} text
 * @returns {boolean}
 */
function passesCheck(text) {
    const settings = getSettings();
    const phrases = getPhraseList();
    if (phrases.length === 0) return true; // nothing required → nothing to skip
    if (!text) return false;

    const haystack = settings.caseSensitive ? text : text.toLowerCase();
    const found = phrases.map(phrase => {
        const needle = settings.caseSensitive ? phrase : phrase.toLowerCase();
        return haystack.includes(needle);
    });

    const pass = settings.matchMode === 'any'
        ? found.some(Boolean)
        : found.every(Boolean);

    tsDebug('check pass =', pass, '| phrases:', phrases, '| mode:', settings.matchMode);
    return pass;
}

/**
 * Get the last message in the chat as plain text (no HTML).
 * Returns null if the last message isn't an AI message.
 * @returns {string|null}
 */
function getLastMessageText() {
    const { chat } = getContext();
    const last = chat?.[chat.length - 1];
    if (!last || last.is_user || last.is_system) return null;
    return String(last.mes || '');
}

// ── The skip loop ──────────────────────────────────────────────

/**
 * Wait until the current generation has fully settled.
 *
 * Event-driven: resolves the moment GENERATION_STOPPED **or** GENERATION_ENDED
 * fires (whichever comes first). STOPPED is the abort path; ENDED fires on
 * normal completion too — listening to both is what keeps this from stalling
 * on builds where STOPPED alone never fires after a completed generation.
 * The timeout is only a safety net (e.g. the extension loaded mid-generation
 * and missed the STARTED event, so generationActive is stale-true with no
 * event coming).
 *
 * @param {number} maxMs safety cap in ms
 * @returns {Promise<void>}
 */
function waitForGenerationSettled(maxMs = 30000) {
    if (!generationActive) return Promise.resolve();

    const { eventSource, eventTypes } = getContext();
    return new Promise(resolve => {
        // ST's own code uses removeListener; off is unverified — use whichever
        // exists, and never let cleanup throw before resolve() or the loop dies.
        const off = typeof eventSource.off === 'function'
            ? eventSource.off.bind(eventSource)
            : (eventSource.removeListener ? eventSource.removeListener.bind(eventSource) : null);
        const onSettled = () => {
            clearTimeout(timer);
            generationActive = false;
            try { off?.(eventTypes.GENERATION_STOPPED, onSettled); } catch { /* ignore */ }
            try { off?.(eventTypes.GENERATION_ENDED, onSettled); } catch { /* ignore */ }
            resolve();
        };
        const timer = setTimeout(onSettled, maxMs);
        eventSource.on(eventTypes.GENERATION_STOPPED, onSettled);
        eventSource.on(eventTypes.GENERATION_ENDED, onSettled);
    });
}

/**
 * Wait until SillyTavern's ENTIRE generation pipeline is idle — not just the
 * generation TurboSkip dispatched, but any follow-up generation ST itself
 * starts: auto-continue (triggerAutoContinue fires a 'continue' Generate
 * synchronously inside our own pipeline's onSuccess), group-chat auto-mode
 * member chains, etc. Those run concurrently with / after our awaited
 * Generate resolves, and streamingProcessor is a shared module global — a
 * regen dispatched while a follow-up is mid-stream races that global
 * (one pipeline nulls it, the other calls .generate() on null → TypeError,
 * and the message the follow-up was writing gets spliced out).
 *
 * Signal: document.body.dataset.generating — set by deactivateSendButtons()
 * at generation start, cleared by activateSendButtons() at generation end —
 * readable without script.js exports and true across the whole chain.
 *
 * @param {number} maxMs safety cap in ms
 * @returns {Promise<void>}
 */
async function waitForPipelineIdle(maxMs = 30000) {
    await waitForGenerationSettled(maxMs);
    let waited = 0;
    while (document.body.dataset.generating && waited < maxMs) {
        await sleep(100);
        waited += 100;
    }
}

/**
 * Dispatch a regeneration by calling Generate('regenerate') directly — the
 * exact function the /regen slash command and the chat menu's Regenerate
 * option both invoke. Awaits the FULL generation pipeline before returning,
 * so a completed dispatch guarantees generation has finished.
 *
 * @returns {Promise<boolean>} true if a regeneration was dispatched.
 */
async function dispatchRegen() {
    const ctx = getContext();

    if (typeof ctx.generate === 'function') {
        tsDebug('dispatching Generate("regenerate") directly');
        try {
            // Awaiting the entire pipeline: the next loop iteration runs only
            // after this generation has completely finished.
            await ctx.generate('regenerate');
            return true;
        } catch (err) {
            console.error('[TurboSkip] Generate("regenerate") failed:', err);
            toastr.error('TurboSkip: regeneration failed — see console (F12) for details.', '', { timeOut: 6000 });
            return false;
        }
    }

    // Fallback: the chat options menu's Regenerate option handler.
    // Its pipeline is not awaitable, so rely on generationActive tracking +
    // waitUntilGenerationIdle() before the next loop iteration.
    const $regen = $('#option_regenerate');
    if ($regen.length) {
        tsDebug('falling back to #option_regenerate trigger');
        $regen.trigger('click');
        return true;
    }

    console.warn('[TurboSkip] no Generate function or regenerate button available in context');
    toastr.error('TurboSkip: could not trigger a regeneration — see console (F12).', '', { timeOut: 6000 });
    return false;
}

/**
 * The serialized check-and-regen loop. Started once per rendered AI message;
 * re-entrant calls are ignored while it runs (the loop drives itself to
 * completion once started).
 */
async function skipLoop() {
    if (skipLoopRunning) return;
    skipLoopRunning = true;

    try {
        const settings = getSettings();
        if (!settings.enabled) return;
        if (getPhraseList().length === 0) return;

        for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
            // The render event that started this loop fired mid-generation,
            // and ST may start follow-up generations (auto-continue, group
            // chains) after ours ends: wait until the whole pipeline is idle
            // before dispatching anything.
            await waitForPipelineIdle();

            const text = getLastMessageText();
            if (text === null) return;   // last message is no longer an AI message — abort
            if (passesCheck(text)) {     // requirement met
                tsDebug('requirement met — done');
                return;
            }

            tsDebug(`phrase check failed, dispatching regen (attempt ${attempt}/${settings.maxAttempts})`);
            if (settings.notifyOnSkip) {
                toastr.info(`TurboSkip: message missing required phrase — regenerating (${attempt}/${settings.maxAttempts})`, '', { timeOut: 2500 });
            }

            const dispatched = await dispatchRegen();
            if (!dispatched) return;     // dispatch itself failed — stop

            // Generate resolves undefined silently on some early guards
            // (offline, interceptor abort, ...) — no generation ever ran, so
            // no ENDED will fire and the next wait would stall pointlessly.
            // Detect it via GENERATION_STARTED: set by onGenerationStarted
            // while our dispatch was in flight.
            if (!generationActive) {
                tsDebug('dispatch resolved but no generation ever started — stopping');
                toastr.warning('TurboSkip: regeneration did not start (generation was blocked) — stopping.', '', { timeOut: 5000 });
                return;
            }
        }

        // All attempts used up — final verdict after the last generation settles.
        await waitForPipelineIdle();
        const text = getLastMessageText();
        if (text !== null && !passesCheck(text)) {
            tsDebug('gave up; message still does not satisfy phrase requirement');
            if (settings.notifyOnSkip) {
                toastr.warning(`TurboSkip: gave up after ${settings.maxAttempts} regenerations — phrase requirement not met.`, '', { timeOut: 5000 });
            }
        }
    } finally {
        skipLoopRunning = false;
    }
}

// ── Event wiring ──────────────────────────────────────────────

function onCharacterMessageRendered() {
    if (suppressRender) return;
    void skipLoop();
}

function onGenerationStarted() {
    generationActive = true;
}

// Both end-events mean the generation is over: STOPPED is the abort path,
// ENDED fires on normal completion too. Clearing on both keeps the flag
// accurate so waitForGenerationSettled never waits on a stale-true flag.
function onGenerationStopped() {
    generationActive = false;
}

function onUserMessageRendered() {
    suppressRender = false;
    // No loop state to reset here: if a loop is mid-run it will abort on its
    // own when it sees the last message is now a user message.
}

function onChatChanged() {
    // Ignore render events fired while a saved chat is being printed, so we
    // don't "fix" the last saved message the moment a chat loads.
    suppressRender = true;
    setTimeout(() => { suppressRender = false; }, 1000);
}

// ── Settings UI ───────────────────────────────────────────────

const SETTINGS_HTML = `
<div id="turbo_skip_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>TurboSkip</b>
            <div class="inline-drawer-icon fa-lg"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label">
                <input id="turbo_skip_enabled" type="checkbox">
                <span>Enabled — auto-regenerate messages missing required phrases</span>
            </label>
            <label class="textarea_label" for="turbo_skip_phrases">
                Required phrases (one per line)
            </label>
            <textarea id="turbo_skip_phrases" class="text_pole textarea_compact" rows="3"
                placeholder="One phrase per line, e.g.&#10;I love you"></textarea>
            <label class="checkbox_label">
                <input id="turbo_skip_case" type="checkbox">
                <span>Case-sensitive matching</span>
            </label>
            <div class="turbo_skip_row">
                <label for="turbo_skip_match_mode">Match mode:</label>
                <select id="turbo_skip_match_mode" class="text_pole">
                    <option value="all">All phrases required</option>
                    <option value="any">Any phrase suffices</option>
                </select>
            </div>
            <div class="turbo_skip_row">
                <label for="turbo_skip_max_attempts">Max regen attempts:</label>
                <input id="turbo_skip_max_attempts" type="number" min="1" max="50" class="text_pole">
            </div>
            <label class="checkbox_label">
                <input id="turbo_skip_notify" type="checkbox">
                <span>Show toast when regenerating</span>
            </label>
        </div>
    </div>
</div>
`;

function initSettingsPanel() {
    const { saveSettingsDebounced } = getContext();

    $('#extensions_settings2').append(SETTINGS_HTML);

    const settings = getSettings();

    $('#turbo_skip_enabled')
        .prop('checked', settings.enabled)
        .on('input', function () {
            getSettings().enabled = $(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#turbo_skip_phrases')
        .val(settings.phrases)
        .on('input', function () {
            getSettings().phrases = String($(this).val());
            saveSettingsDebounced();
        });

    $('#turbo_skip_case')
        .prop('checked', settings.caseSensitive)
        .on('input', function () {
            getSettings().caseSensitive = $(this).prop('checked');
            saveSettingsDebounced();
        });

    $('#turbo_skip_match_mode')
        .val(settings.matchMode)
        .on('change', function () {
            getSettings().matchMode = String($(this).val());
            saveSettingsDebounced();
        });

    $('#turbo_skip_max_attempts')
        .val(settings.maxAttempts)
        .on('input', function () {
            getSettings().maxAttempts = Math.max(1, parseInt(String($(this).val()), 10) || 1);
            saveSettingsDebounced();
        });

    $('#turbo_skip_notify')
        .prop('checked', settings.notifyOnSkip)
        .on('input', function () {
            getSettings().notifyOnSkip = $(this).prop('checked');
            saveSettingsDebounced();
        });
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
    getSettings(); // ensure defaults exist

    const { eventSource, eventTypes } = getContext();
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(eventTypes.GENERATION_STOPPED, onGenerationStopped);
    eventSource.on(eventTypes.GENERATION_ENDED, onGenerationStopped);

    initSettingsPanel();
    tsDebug('initialized');
}

init().catch(err => console.error('[TurboSkip] init failed:', err));