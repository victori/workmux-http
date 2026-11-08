// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeSheet } from './ThemeSheet'

afterEach(cleanup)

describe('ThemeSheet', () => {
  it('renders every theme with the current one checked', () => {
    render(<ThemeSheet themeId="night" onSelect={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('radio', { name: /Night/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: /Gruvbox/ })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: /Twilight/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('selecting a theme applies via callback and closes the sheet', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ThemeSheet themeId="night" onSelect={onSelect} onClose={onClose} />)
    fireEvent.click(screen.getByRole('radio', { name: /Gruvbox/ }))
    expect(onSelect).toHaveBeenCalledWith('gruvbox')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
