/**
 * TurboSkip — auto-regenerates AI messages until they contain the phrases you require.
 *
 * After each AI message renders, checks the message text against a configurable
 * list of required phrases. If the requirement isn't met, triggers a
 * regeneration (/regen await=true) and re-checks — up to a max attempt count.
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
    // Small pause (ms) after a regen finishes before checking the new text.
    checkDelay: 100,
    // Show a toast when a message is regenerated.
    notifyOnSkip: true,
};

// ── State ────────────────────────────────────────────────────

let busy = false; // true while our own regen loop is driving generation

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    const { extensionSettings, saveSettingsDebounced } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
        saveSettingsDebounced();
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

// ── Regen loop ────────────────────────────────────────────────

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Execute /regen await=true through the public slash-command API.
 */
async function executeRegen() {
    const ctx = getContext();
    if (typeof ctx.executeSlashCommandsWithOptions === 'function') {
        await ctx.executeSlashCommandsWithOptions('/regen await=true');
    } else if (typeof ctx.executeSlashCommands === 'function') {
        // older ST builds
        await ctx.executeSlashCommands('/regen await=true');
    } else {
        console.warn('[TurboSkip] no slash-command executor available in context');
    }
}

/**
 * The skip loop: while the latest AI message fails the phrase check and
 * attempts remain, regenerate it. Guards against user messages arriving
 * mid-loop (re-checks that the last message is still the one being skipped).
 */
async function skipLoop() {
    const settings = getSettings();
    let attempt = 0;

    while (attempt < settings.maxAttempts) {
        await sleep(settings.checkDelay);

        const text = getLastMessageText();
        if (text === null) return; // last message is no longer an AI message — abort
        if (passesCheck(text)) return; // requirement met — done

        attempt++;
        tsDebug(`phrase check failed, regenerating (attempt ${attempt}/${settings.maxAttempts})`);

        if (settings.notifyOnSkip) {
            toastr.info(`TurboSkip: regenerating message — missing required phrase (${attempt}/${settings.maxAttempts})`, '', { timeOut: 2500 });
        }

        busy = true;
        try {
            await executeRegen();
        } catch (err) {
            console.error('[TurboSkip] regen failed:', err);
            return;
        } finally {
            busy = false;
        }
    }

    // All attempts used — give the final verdict
    await sleep(settings.checkDelay);
    const text = getLastMessageText();
    if (text !== null && !passesCheck(text)) {
        toastr.warning(`TurboSkip: gave up after ${settings.maxAttempts} regenerations — phrase requirement not met.`, '', { timeOut: 5000 });
        tsDebug('gave up; message still does not satisfy phrase requirement');
    }
}

// ── Event wiring ──────────────────────────────────────────────

function onCharacterMessageRendered() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (busy) return; // our own regen's render event — the loop already drives it
    void skipLoop();
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

    initSettingsPanel();
    tsDebug('initialized');
}

init().catch(err => console.error('[TurboSkip] init failed:', err));