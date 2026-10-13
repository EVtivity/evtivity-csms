// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardList,
  CardListItem,
  CardListLink,
  CardTitle,
} from '../ui/card';

afterEach(() => {
  cleanup();
});

describe('Card variants', () => {
  it('defaults keep the original card classes', () => {
    render(
      <Card data-testid="card">
        <CardHeader data-testid="header">
          <CardTitle>Title</CardTitle>
        </CardHeader>
        <CardContent data-testid="content">Body</CardContent>
        <CardFooter data-testid="footer">Foot</CardFooter>
      </Card>,
    );
    expect(screen.getByTestId('card').className).toContain('rounded-lg');
    expect(screen.getByTestId('card').className).not.toContain('border-warning');
    expect(screen.getByTestId('header').className).toContain('flex-col');
    expect(screen.getByText('Title').className).toContain('text-2xl');
    expect(screen.getByTestId('content').className).toContain('p-6');
    expect(screen.getByTestId('footer').className).toContain('pt-0');
  });

  it('the stat header and title match the dashboard stat cards', () => {
    render(
      <CardHeader variant="stat" data-testid="header">
        <CardTitle variant="stat">Total Stations</CardTitle>
      </CardHeader>,
    );
    const header = screen.getByTestId('header').className.split(' ');
    for (const c of ['flex-row', 'items-center', 'justify-between', 'pb-2']) {
      expect(header).toContain(c);
    }
    const title = screen.getByText('Total Stations').className.split(' ');
    expect(title).toContain('text-sm');
    expect(title).toContain('font-medium');
    expect(title).not.toContain('text-2xl');
  });

  it('the warning tone only changes the border', () => {
    render(<Card tone="warning" data-testid="card" />);
    const classes = screen.getByTestId('card').className.split(' ');
    expect(classes).toContain('border-warning/60');
    expect(classes).toContain('bg-card');
  });

  it('the ai tone lays a brand gradient over the card color', () => {
    render(<Card tone="ai" data-testid="card" />);
    const classes = screen.getByTestId('card').className.split(' ');
    expect(classes).toEqual(
      expect.arrayContaining([
        'bg-card',
        'bg-linear-to-br',
        'from-primary/10',
        'via-card',
        'to-info/10',
      ]),
    );
  });

  it('a list body runs its rows edge to edge, and a divided footer sits under a border', () => {
    render(
      <MemoryRouter>
        <Card>
          <CardContent variant="list" data-testid="content">
            <CardList>
              <CardListItem>Plain row</CardListItem>
              <CardListLink to="/somewhere">Linked row</CardListLink>
            </CardList>
          </CardContent>
          <CardFooter variant="divided" data-testid="footer">
            View all
          </CardFooter>
        </Card>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('content').className).toBe('p-0');
    expect(screen.getByText('Plain row').className).toContain('px-6');
    const link = screen.getByRole('link', { name: 'Linked row' });
    expect(link.getAttribute('href')).toBe('/somewhere');
    expect(link.className).toContain('hover:bg-accent');
    expect(link.className).toContain('focus-visible:ring-2');
    const footer = screen.getByTestId('footer').className.split(' ');
    expect(footer).toContain('border-t');
    expect(footer).toContain('justify-end');
  });
});
