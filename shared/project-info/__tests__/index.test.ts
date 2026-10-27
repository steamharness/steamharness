import { describe, expect, it } from 'vitest';
import { createDefaultProjectInfo, createUndeclaredProjectInfo, listProjectSearchNames, matchesProjectSearch, normalizeDeclaredProjectInfoInput, normalizeProjectInfo, readProjectInfo, resolveProjectName, serializeProjectInfo, writeProjectInfo } from '../index';
describe('aggregate project information',()=>{
  it('keeps product information independent of database resources',()=>{
    expect(readProjectInfo({name:'Project'})).toEqual(createUndeclaredProjectInfo());
    expect(createDefaultProjectInfo()).not.toHaveProperty('dataStorage');
    expect(createDefaultProjectInfo()).not.toHaveProperty('relatedProjects');
    expect(normalizeDeclaredProjectInfoInput({})).toEqual(createDefaultProjectInfo());
  });
  it('rejects removed database and related-project declarations',()=>{
    for(const field of ['dataStorage','relatedProjects']){
      expect(()=>normalizeProjectInfo({[field]:[]})).toThrow(/removed/);
      expect(()=>readProjectInfo({steamHarness:{projectInfo:{[field]:[]}}})).toThrow(/removed/);
    }
  });
  it('normalizes names and preserves future declaration and platform IDs',()=>{
    const info=normalizeProjectInfo({localizedNames:{'zh-CN':' 中文名称 ',en:'English Name',ja:'日本語',empty:' '},declarations:['multilingual','future','multilingual'],platformSupport:{mode:'specific',platforms:['macos','future-os','macos']}});
    expect(info).toEqual({localizedNames:{'zh-CN':'中文名称',en:'English Name',ja:'日本語'},declarations:['multilingual','future'],platformSupport:{mode:'specific',platforms:['macos','future-os']}});
    expect(resolveProjectName('Default',info,'zh-Hans')).toBe('中文名称');
    expect(resolveProjectName('Default',info,'en-US')).toBe('English Name');
    expect(resolveProjectName('Default',info,'fr')).toBe('Default');
    expect(listProjectSearchNames('Default',info)).toEqual(['Default','中文名称','English Name','日本語']);
    expect(matchesProjectSearch('Default',info,'english')).toBe(true);
    expect(matchesProjectSearch('Default',info,'中文')).toBe(true);
    expect(serializeProjectInfo(info)).toEqual(info);
  });
  it('rejects incompatible platform modes',()=>{
    expect(()=>normalizeProjectInfo({platformSupport:{mode:'agnostic',platforms:[]}})).toThrow(/agnostic/);
    expect(()=>normalizeProjectInfo({platformSupport:{mode:'specific',platforms:[]}})).toThrow(/at least one/);
  });
  it('writes information while preserving aggregate registration and package fields',()=>{
    const config={entries:[{entryId:'main'}],defaultEntry:'main',future:true};
    const info={localizedNames:{en:'English'},declarations:['multilingual'],platformSupport:{mode:'specific' as const,platforms:['web']}};
    expect(writeProjectInfo({name:'Default',steamHarness:config},info)).toEqual({name:'Default',steamHarness:{...config,projectInfo:info}});
  });
});
