/* Tests P1: cola — drena pendientes aunque se limpie durante el proceso. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { montarFixture } from '../test/fixture';

montarFixture();
const { buscarSlot, crearHoja, state } = await import('../state');
const { procesarCola } = await import('./queue');
const { comprobante } = await import('../test/factoria');

beforeEach(() => {
  // La cola MOCK usa sleep(900ms): se avanza a mano con timers falsos.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('procesarCola', () => {
  it('limpiar durante el proceso no deja huérfano al archivo nuevo', async () => {
    const h = crearHoja();
    const viejo = comprobante({ nombre: 'viejo.png' });
    h.slots[0] = viejo;
    state.hojas.push(h);
    const p = procesarCola();
    expect(viejo.estado).toBe('procesando');
    // Limpiar reemplaza el array (cierra modalLimpiar con 'ok').
    const nh = crearHoja();
    const nuevo = comprobante({ nombre: 'nuevo.png' });
    nh.slots[0] = nuevo;
    state.hojas = [nh];
    await vi.advanceTimersByTimeAsync(1000); // termina el sleep del viejo (descartado)
    await vi.advanceTimersByTimeAsync(1000); // procesa el nuevo
    await p;
    expect(buscarSlot(viejo.id)).toBeNull();
    expect(nuevo.estado).toBe('ok');
    expect(nuevo.montoCents).toBe(123456);
    expect(state.colaEnProceso).toBe(false);
  });
});
