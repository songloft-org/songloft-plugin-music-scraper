import type { Song } from '@songloft/plugin-sdk'

export type Layout = 'original' | 'flat' | 'artist-album'
export type Filename = 'artist-title' | 'title' | 'original'
export type Preset = { directories: string[]; layout: Layout; filename: Filename }
export type IndexedTrack = Pick<Song, 'id' | 'file_path' | 'title' | 'artist' | 'album'> & { relative_path: string }
export type Library = { root: string; tracks: IndexedTrack[]; fingerprint_available: boolean }
export type FileInfo = {
  song: Song; relative_path: string; revision: string; protected: string[];
  lookup_lyrics: boolean; lookup_cover: boolean
}
export type Candidate = {
  id: string; title: string; artists: string[]; album?: string; albums?: string[];
  version?: string; duration: number; year?: number; track?: string; isrc?: string;
  release_id?: string; method: 'text' | 'fingerprint'
}
export type Result = {
  song_id: number; path: string; target?: string; state: string; detail?: string;
  warning?: string; match?: Candidate; candidates?: Candidate[]
}
export type RecordEntry = { result: Result; file?: FileInfo; selection?: string }
export type Job = { id: string; state: string; preset: Preset; total: number; checked: number; detail?: string }
export type Lyrics = { lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string }

export interface Operation {
  check(): void
  wait<T>(request: Promise<T>): Promise<T>
}
