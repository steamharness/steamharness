import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MarkdownContent } from '../run-workspace/markdown/markdown-content';

const address = 'database://bbdbf868-5309-4949-b6de-63def9412baf/files/d50cb487-c9cb-45dd-bd8c-e2e26ea84cb8';
it('passes a space attachment image through the authenticated host resolver', async () => {
  const resolve = vi.fn(async () => 'blob:approved-attachment');
  render(<MarkdownContent content={`![Map](${address})`} resolveImageSrc={resolve} />);
  await waitFor(() => expect(resolve).toHaveBeenCalledWith(address));
  expect(screen.getByAltText('Map')).toHaveAttribute('src', 'blob:approved-attachment');
});
it('keeps attachment schemes out of links and rejects malformed image addresses', () => {
  const resolve = vi.fn();
  render(<MarkdownContent content={`[Link](${address})\n\n![Invalid](database://other/files/file)\n\n![Script](javascript:alert)`} resolveImageSrc={resolve} />);
  expect(screen.getByText('Link')).not.toHaveAttribute('href', address);
  expect(resolve).not.toHaveBeenCalled();
});
