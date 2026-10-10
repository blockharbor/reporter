// @vitest-environment jsdom
//
// jsdom is scoped to this file by the docblock above rather than set globally in
// vitest.config.ts: the rest of the suite is pure logic and runs in node.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination.js';

// vitest runs without `globals`, so RTL's auto-cleanup never registers itself.
afterEach(cleanup);

describe('Pagination', () => {
  it('renders nothing for a single page', () => {
    const { container } = render(<Pagination page={1} totalPages={1} onPageChange={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('disables Previous on the first page and Next on the last', () => {
    const { rerender } = render(<Pagination page={1} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false);

    rerender(<Pagination page={5} totalPages={5} onPageChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true);
  });

  it('reports the neighbouring page and names the position', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} totalPages={5} onPageChange={onPageChange} />);
    expect(screen.getByText('Page 2 of 5')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('is a labelled navigation landmark', () => {
    render(<Pagination page={1} totalPages={2} onPageChange={vi.fn()} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeTruthy();
  });
});
