import { expect, it } from 'vitest';
import { cropOutputSize, imageOutputType, imageSizeAllowed } from '../web/ui/image-crop-size';

const limits = { minWidth: 280, minHeight: 280, maxWidth: 1568, maxHeight: 1568 };

it('fits large and small crops without stretching and pads incompatible aspect ratios', () => {
  expect(cropOutputSize({ width: 4000, height: 2000 }, limits)).toEqual({ width: 1568, height: 784, contentWidth: 1568, contentHeight: 784 });
  expect(cropOutputSize({ width: 100, height: 100 }, limits)).toEqual({ width: 280, height: 280, contentWidth: 280, contentHeight: 280 });
  expect(cropOutputSize({ width: 4000, height: 100 }, limits)).toEqual({ width: 1568, height: 280, contentWidth: 1568, contentHeight: 39 });
  expect(cropOutputSize({ width: 100, height: 4000 }, limits)).toEqual({ width: 280, height: 1568, contentWidth: 39, contentHeight: 1568 });
  expect(cropOutputSize({ width: 400, height: 320 }, {})).toEqual({ width: 400, height: 320, contentWidth: 400, contentHeight: 320 });
  expect(cropOutputSize({ width: 100, height: 200 }, { minWidth: 500 })).toEqual({ width: 500, height: 1000, contentWidth: 500, contentHeight: 1000 });
});

it('honors each declared bound and chooses an export format accepted by the parameter', () => {
  expect(imageSizeAllowed({ width: 280, height: 1568 }, limits)).toBe(true);
  expect(imageSizeAllowed({ width: 279, height: 300 }, limits)).toBe(false);
  expect(imageSizeAllowed({ width: 300, height: 1569 }, limits)).toBe(false);
  expect(imageOutputType({ name: 'photo.jpg', type: 'image/jpeg' }, ['image/png'])).toBe('image/png');
  expect(imageOutputType({ name: 'photo.jpg', type: 'image/jpeg' }, ['.jpg', '.png'])).toBe('image/jpeg');
  expect(imageOutputType({ name: 'drawing.svg', type: 'image/svg+xml' }, ['image/svg+xml'])).toBe('');
});
