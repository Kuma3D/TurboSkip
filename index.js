/**
 * TurboSkip — auto-regenerates AI messages until they contain the phrases you require.
 *
 * When an AI message renders, its text is checked against a configurable list
 * of required phrases. If the requirement isn't met, TurboSkip dispatches
 * /regen (plain — no named args, for compatibility with all ST builds) and
 * re-checks when the regenerated message renders, up to a max attempt count.
 *
 * The retry loop is event-driven: there is no reliance on the slash command
 * promise resolving after generation completes (which requires an `await=true`
 * named argument not present in all ST versions).
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

let awaitingSkip = false;   // a /regen we dispatched hasn't rendered its message yet
let attempts = 0;           // regens dispatched for the current message
let suppressRender = false; // ignore render events right after a chat switch

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

function resetSkipState() {
    awaitingSkip = false;
    attempts = 0;
}

function tsDebug(...args) {
    console.debug('[TurboSkip]', ...args);
}

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

// ── Regen dispatch ─────────────────────────────────────────────

/**
 * Dispatch a plain /regen slash command (no named arguments — `await=true`
 * is not supported on all ST builds, and the retry loop doesn't need it:
 * the next CHARACTER_MESSAGE_RENDERED event is our completion signal).
 * Fire-and-forget from the caller's perspective.
 */
async function dispatchRegen() {
    const ctx = getContext();
    try {
        if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
            await ctx.executeSlashCommandsWithOptions('/regen');
        } else if (typeof ctx.executeSlashCommands === 'function') {
            await ctx.executeSlashCommands('/regen'); // older ST builds
        } else {
            console.warn('[TurboSkip] no slash-command executor available in context');
            toastr.error('TurboSkip: this SillyTavern build exposes no slash-command API — cannot regenerate.', '', { timeOut: 6000 });
            resetSkipState();
        }
    } catch (err) {
        console.error('[TurboSkip] /regen failed:', err);
        toastr.error('TurboSkip: /regen failed — see console (F12) for details.', '', { timeOut: 6000 });
        resetSkipState();
    }
}

// ── Event wiring ──────────────────────────────────────────────

function onCharacterMessageRendered() {
    if (suppressRender) return;

    // A render while a regen we dispatched is pending is that regen's result.
    if (awaitingSkip) {
        awaitingSkip = false;
    }

    const settings = getSettings();
    if (!settings.enabled) return;
    if (getPhraseList().length === 0) return;

    const text = getLastMessageText();
    if (text === null) return;      // last message isn't an AI message
    if (passesCheck(text)) {
        attempts = 0;                // requirement met — reset for next message
        return;
    }

    if (attempts >= settings.maxAttempts) {
        if (settings.notifyOnSkip) {
            toastr.warning(`TurboSkip: gave up after ${settings.maxAttempts} regenerations — phrase requirement not met.`, '', { timeOut: 5000 });
        }
        tsDebug('gave up; message still does not satisfy phrase requirement');
        resetSkipState();
        return;
    }

    attempts++;
    tsDebug(`phrase check failed, dispatching /regen (attempt ${attempts}/${settings.maxAttempts})`);

    if (settings.notifyOnSkip) {
        toastr.info(`TurboSkip: message missing required phrase — regenerating (${attempts}/${settings.maxAttempts})`, '', { timeOut: 2500 });
    }

    awaitingSkip = true;
    void dispatchRegen();
}

function onUserMessageRendered() {
    // A new user message starts a fresh exchange — reset per-message state.
    resetSkipState();
    suppressRender = false;
}

function onChatChanged() {
    resetSkipState();
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

    initSettingsPanel();
    tsDebug('initialized');
}

init().catch(err => console.error('[TurboSkip] init failed:', err));