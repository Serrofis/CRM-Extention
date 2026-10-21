// Plays the Director / Autopilot alert sounds (an offscreen extension page
// may play audio without a click on the page).
'use strict';
let wpAudio = null;
function wpTone(freq, start, length, volume) {
    const osc = wpAudio.createOscillator();
    const gain = wpAudio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, wpAudio.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(volume, wpAudio.currentTime + start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, wpAudio.currentTime + start + length);
    osc.connect(gain).connect(wpAudio.destination);
    osc.start(wpAudio.currentTime + start);
    osc.stop(wpAudio.currentTime + start + length + 0.05);
}
chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'WP_OFFSCREEN_SOUND') return;
    if (!wpAudio) wpAudio = new AudioContext();
    if (message.kind === 'urgent') {
        // Three quick high beeps.
        [0, 0.22, 0.44].forEach((start) => wpTone(1175, start, 0.16, 0.35));
    } else {
        // A soft two-note chime.
        wpTone(880, 0, 0.18, 0.25);
        wpTone(1320, 0.16, 0.28, 0.25);
    }
});