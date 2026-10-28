export { writeFile as writeProjectFixture } from 'node:fs/promises';
export function projectFixtureFiles<T extends {path:string;content?:string}>(files:T[]):T[];
export function projectFixtureArchive(files:Record<string,string>):Record<string,string>;
