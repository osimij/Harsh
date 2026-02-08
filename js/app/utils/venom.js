export function applyVenomSimParams(simParams, { time = 0, morphT = 1, chaosT = 0, strength = 1 } = {}) {
    if (!simParams) return simParams;

    const t = Number(time) || 0;
    const m = Number(morphT) || 0;
    const c = Number(chaosT) || 0;
    const s = Math.max(0, Math.min(1, Number(strength) || 0));
    if (s <= 0) return simParams;

    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + m * Math.PI * 2);
    const surge = 0.5 + 0.5 * Math.sin(t * 0.9 + c * 3.0);

    const mix = (a, b, t0) => a + (b - a) * t0;

    const noiseScale = Number(simParams.noiseScale ?? 3.0);
    simParams.noiseScale = mix(noiseScale, Math.max(1.0, noiseScale * 0.88), s);

    const noiseStrength = Number(simParams.noiseStrength ?? 1.0);
    simParams.noiseStrength = mix(noiseStrength, noiseStrength * (1.2 + 0.45 * pulse), s);

    const noiseSpeed = Number(simParams.noiseSpeed ?? 0.18);
    simParams.noiseSpeed = mix(noiseSpeed, noiseSpeed * (1.05 + 0.45 * pulse), s);

    const vortexStrength = Number(simParams.vortexStrength ?? 1.0);
    simParams.vortexStrength = mix(vortexStrength, vortexStrength * (1.1 + 0.5 * surge), s);

    const vortexRadius = Number(simParams.vortexRadius ?? 0.7);
    simParams.vortexRadius = mix(vortexRadius, Math.max(0.35, vortexRadius * 0.82), s);

    const repulseStrength = Number(simParams.repulseStrength ?? 1.0);
    simParams.repulseStrength = mix(repulseStrength, repulseStrength * (1.15 + 0.55 * pulse), s);

    const attractStrength = Number(simParams.attractStrength ?? 2.4);
    simParams.attractStrength = mix(attractStrength, attractStrength * (1.05 + 0.2 * surge), s);

    const drag = Number(simParams.drag ?? 1.1);
    simParams.drag = mix(drag, Math.max(0.2, drag * 0.82), s);

    const maxSpeed = Number(simParams.maxSpeed ?? 2.2);
    simParams.maxSpeed = mix(maxSpeed, maxSpeed * (1.15 + 0.25 * pulse), s);

    const burstStrength = Number(simParams.burstStrength ?? 0);
    simParams.burstStrength = mix(burstStrength, burstStrength * (1.0 + 0.4 * pulse), s);

    const nextFieldStrength = Number(simParams.nextFieldStrength ?? 0);
    simParams.nextFieldStrength = mix(nextFieldStrength, nextFieldStrength * (1.2 + 0.3 * surge), s);

    return simParams;
}
