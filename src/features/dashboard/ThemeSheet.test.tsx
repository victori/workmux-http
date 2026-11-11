// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeSheet } from './ThemeSheet'

afterEach(cleanup)

describe('ThemeSheet', () => {
  it('renders every theme with the current one checked', () => {
    render(<ThemeSheet themeId="night" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /^Night$/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /^Gruvbox$/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: /^Twilight$/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('lists dark and light themes under section headers', () => {
    render(<ThemeSheet themeId="night" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByText('Dark')).toBeInTheDocument()
    expect(screen.getByText('Light')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Dracula$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Catppuccin Mocha$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^GitHub Light$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Solarized Light$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Catppuccin Latte$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^One Light$/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Gruvbox Light$/ })).toBeInTheDocument()
  })

  it('selecting a theme applies via callback and closes the sheet', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ThemeSheet themeId="night" onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByRole('radio', { name: /^Gruvbox$/ }))
    expect(onSelect).toHaveBeenCalledWith('gruvbox')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('selecting a light theme reports its id', () => {
    const onSelect = vi.fn()
    render(<ThemeSheet themeId="night" onSelect={onSelect} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('radio', { name: /^GitHub Light$/ }))
    expect(onSelect).toHaveBeenCalledWith('github-light')
  })
})
