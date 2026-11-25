// Plays the Director / Autopilot alert sounds (an offscreen extension page
// may play audio without a click on the page).
'use strict';
let wpAudio = null;
// 1.7.483: calm sounds — a soft bell (gentle fade in, long smooth fade out, low and quiet).
// The old ones were sharp high beeps.
function wpSoftTone(freq, start, length, volume) {
    const t = wpAudio.currentTime + start;
    const osc = wpAudio.createOscillator();
    const gain = wpAudio.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.12);
    gain.gain.setTargetAtTime(0, t + 0.15, length / 4);
    osc.connect(gain).connect(wpAudio.destination);
    osc.start(t);
    osc.stop(t + length + 0.3);
}
chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'WP_OFFSCREEN_SOUND') return;
    if (!wpAudio) wpAudio = new AudioContext();
    if (wpAudio.state === 'suspended') { try { wpAudio.resume(); } catch (_) {} }
    if (message.kind === 'urgent') {
        // Needs you (wlcm paused): three soft notes going down, a little louder.
        wpSoftTone(659.25, 0, 0.9, 0.1);    // E5
        wpSoftTone(587.33, 0.3, 0.9, 0.1);  // D5
        wpSoftTone(523.25, 0.6, 1.3, 0.1);  // C5
    } else {
        // Something to look at: a calm two-note chime.
        wpSoftTone(523.25, 0, 1.1, 0.07);    // C5
        wpSoftTone(659.25, 0.28, 1.3, 0.06); // E5
    }
});
