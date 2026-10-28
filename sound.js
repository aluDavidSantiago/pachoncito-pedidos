// Sonido de la interfaz: tonos sintetizados con Web Audio (sin archivos ni librerías), a volumen muy bajo.
// Solo suena en tres momentos (añadir producto, ganar una ñapa y reservar), nunca al pasar el cursor ni al escribir.
// El AudioContext se crea en la primera interacción del usuario, como exigen las políticas de autoplay.
import { storage } from "./shared.js";

const PREF_KEY = 'pachoncito_sound';
const MASTER_VOLUME = 0.07;

let ctx = null;
let master = null;
let noise = null;
let enabled = storage.get(PREF_KEY) !== false; // activado salvo que el cliente lo silencie

export const isSoundEnabled = () => enabled;

export function setSoundEnabled(value) {
    enabled = Boolean(value);
    storage.set(PREF_KEY, enabled);
    if (master) master.gain.setTargetAtTime(enabled ? MASTER_VOLUME : 0, ctx.currentTime, 0.02);
}

function unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!ctx) {
        ctx = new AudioCtx();
        // Compresor suave: evita picos cuando coinciden dos sonidos
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -18;
        limiter.ratio.value = 4;
        master = ctx.createGain();
        master.gain.value = enabled ? MASTER_VOLUME : 0;
        master.connect(limiter).connect(ctx.destination);
        // 80 ms de ruido para el golpe de madera, generado una sola vez
        noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.08), ctx.sampleRate);
        const data = noise.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
}

['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, unlock, { capture: true, passive: true }));

const ready = () => enabled && ctx && ctx.state === 'running';

// Nota con envolvente: ataque corto y caída exponencial (sonido de campana o de madera, sin clics)
function tone(freq, { start = 0, duration = 0.4, gain = 1, type = 'sine', attack = 0.005, glideTo = null } = {}) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(env).connect(master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
    osc.onended = () => env.disconnect();
}

// 1. Añadir producto: toque de madera seco (ruido filtrado + cuerpo grave que cae rápido)
export function playTap() {
    if (!ready()) return;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    const band = ctx.createBiquadFilter();
    const env = ctx.createGain();
    src.buffer = noise;
    band.type = 'bandpass';
    band.frequency.value = 1900;
    band.Q.value = 3;
    env.gain.setValueAtTime(0.5, t0);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
    src.connect(band).connect(env).connect(master);
    src.start(t0);
    src.onended = () => env.disconnect();
    tone(420, { duration: 0.07, gain: 0.55, type: 'triangle', attack: 0.002, glideTo: 260 });
}

// 2. Ganar una ñapa: arpegio ascendente y luminoso (Do–Mi–Sol–Do)
export function playReward() {
    if (!ready()) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        tone(freq, { start: i * 0.07, duration: 0.55, gain: 0.32, attack: 0.01 });
    });
}

// 3. Pedido reservado: acorde cálido de cierre (Fa mayor con la octava al final)
export function playSuccess() {
    if (!ready()) return;
    [349.23, 440, 523.25].forEach(freq => tone(freq, { duration: 1.1, gain: 0.22, type: 'triangle', attack: 0.025 }));
    tone(698.46, { start: 0.12, duration: 0.9, gain: 0.18, attack: 0.02 });
}
