import * as imageRepository from '../src/repositories/image.repository';

jest.mock('../src/repositories/image.repository');
jest.mock('../src/config/db', () => ({ pool: { query: jest.fn() } }));

import { checkDuplicate } from '../src/services/duplicateDetection.service';

const mockedFindRecent = imageRepository.findRecentImagesWithHash as jest.Mock;

describe('checkDuplicate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns pass with no duplicate when no prior images exist', async () => {
    mockedFindRecent.mockResolvedValue([]);
    const result = await checkDuplicate('img-1', 'ff00ff00ff00ff00');
    expect(result.status).toBe('pass');
    expect(result.isDuplicate).toBe(false);
  });

  it('flags an exact-hash match as a duplicate', async () => {
    mockedFindRecent.mockResolvedValue([
      { id: 'img-2', phash: 'ff00ff00ff00ff00' } as any,
    ]);
    const result = await checkDuplicate('img-1', 'ff00ff00ff00ff00');
    expect(result.isDuplicate).toBe(true);
    expect(result.hammingDistance).toBe(0);
    expect(result.similarity).toBe(1);
    expect(result.status).toBe('warning');
  });

  it('does not flag a very different hash as a duplicate', async () => {
    mockedFindRecent.mockResolvedValue([
      { id: 'img-2', phash: '0000000000000000' } as any,
    ]);
    const result = await checkDuplicate('img-1', 'ffffffffffffffff');
    expect(result.isDuplicate).toBe(false);
    expect(result.status).toBe('pass');
  });

  it('returns a warning with no comparison when phash is missing', async () => {
    const result = await checkDuplicate('img-1', null);
    expect(result.status).toBe('warning');
    expect(result.isDuplicate).toBe(false);
    expect(mockedFindRecent).not.toHaveBeenCalled();
  });
});
