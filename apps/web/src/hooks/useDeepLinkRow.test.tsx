// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
//
// Deliberately NOT tested here: that the row actually ends up centred on screen.
// jsdom has no layout and no scrolling, so `scrollIntoView` is a stub — we assert
// that it is called with the right element and options, which is the whole of what
// this hook decides. Whether the result *looks* right is a browser question.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEEP_LINK_HIGHLIGHT_MS, useDeepLinkRow } from './useDeepLinkRow.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame'] });
  // jsdom implements no layout, so scrollIntoView does not exist on an element.
  Element.prototype.scrollIntoView = vi.fn();
  // Not faked by jsdom either; the hook reads it to honour reduced motion.
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A page with three addressable rows, standing in for the real callers: `?row=`
 * names a row by its 0-based position, a position past the end names nothing, and
 * `reveal` records that the row's container was opened before the scroll.
 */
function Rows({ count, ready, revealed }: { count: number; ready: boolean; revealed: string[] }) {
  const highlighted = useDeepLinkRow(
    'row',
    (raw) => {
      if (!/^\d+$/.test(raw)) return null;
      const index = Number(raw);
      if (index >= count) return null;
      return { rowId: `row-${index}`, reveal: () => revealed.push(raw) };
    },
    ready,
  );
  const location = useLocation();
  return (
    <div>
      <p data-testid="search">{location.search}</p>
      <p data-testid="flashed">{highlighted ?? 'none'}</p>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} id={`row-${i}`} data-testid={`row-${i}`}>
          row {i}
        </div>
      ))}
    </div>
  );
}

/** Mount {@link Rows} at `?row=<raw>`, with its three rows already loaded. */
function mount(search: string) {
  const revealed: string[] = [];
  const view = render(
    <MemoryRouter initialEntries={[`/engagements/op/reports${search}`]}>
      <Rows count={3} ready revealed={revealed} />
    </MemoryRouter>,
  );
  return { ...view, revealed };
}

const search = () => screen.getByTestId('search').textContent;
const flashed = () => screen.getByTestId('flashed').textContent;

describe('useDeepLinkRow', () => {
  it('reveals, flashes and scrolls to the addressed row, then drops the param', () => {
    const { revealed } = mount('?row=1');

    expect(revealed).toEqual(['1']);
    expect(flashed()).toBe('1');
    // Dropped with `replace`, so a refresh or a Back/Forward can't replay the jump.
    expect(search()).toBe('');

    // The scroll is deferred one frame: `reveal` expanded the container in the
    // same commit that set the highlight, so the row only exists after it.
    act(() => void vi.advanceTimersToNextFrame());
    const scrollIntoView = screen.getByTestId('row-1').scrollIntoView;
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('clears the flash once it has had its moment', () => {
    mount('?row=2');
    expect(flashed()).toBe('2');

    act(() => void vi.advanceTimersByTime(DEEP_LINK_HIGHLIGHT_MS));
    expect(flashed()).toBe('none');
  });

  it('drops a param that addresses nothing, flashing no row', () => {
    // The regression: a link to a row deleted since it was made used to `return`
    // before the cleanup, leaving `?row=7` in the address bar forever, silently
    // re-evaluated on every render, with the author shown nothing at all.
    const { revealed } = mount('?row=7');

    expect(search()).toBe('');
    expect(flashed()).toBe('none');
    expect(revealed).toEqual([]);
  });

  it('flashes nothing for a param with an empty value', () => {
    // The regression: `Number('')` is 0, so a bare `?row=` used to pass an
    // `Number.isInteger` check and flash the first row on arrival.
    mount('?row=');

    expect(flashed()).toBe('none');
    expect(search()).toBe('');
  });

  it('ignores a page it was never pointed at', () => {
    mount('');

    expect(flashed()).toBe('none');
    expect(search()).toBe('');
  });

  it('holds the param until the page data has arrived', () => {
    // The data loads in an effect, so the first pass sees an empty list. Judging
    // the index then would read every good link as stale and drop it.
    function Loading() {
      const [ready, setReady] = useState(false);
      return (
        <>
          <button onClick={() => setReady(true)}>load</button>
          <Rows count={ready ? 3 : 0} ready={ready} revealed={[]} />
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={['/engagements/op/goals?row=1']}>
        <Loading />
      </MemoryRouter>,
    );

    expect(flashed()).toBe('none');
    expect(search()).toBe('?row=1');

    fireEvent.click(screen.getByText('load'));
    expect(flashed()).toBe('1');
    expect(search()).toBe('');
  });

  it('scrolls without animation when the reader asks for reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof matchMedia;
    mount('?row=0');

    act(() => void vi.advanceTimersToNextFrame());
    expect(screen.getByTestId('row-0').scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'center',
    });
  });
});
