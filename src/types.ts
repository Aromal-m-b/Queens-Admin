export type CellValue = "" | "." | "Q";

export type Difficulty = "easy" | "medium" | "hard";

export interface CellCoords {
  r: number;
  c: number;
}

export interface BoardDefinition {
  id: string;
  difficulty: Difficulty;
  size: number;
  grid: number[][]; // grid[r][c] contains region ID
  solution: CellCoords[];
  colors?: string[];
}

export interface GameStats {
  elapsedSeconds: number;
  movesCount: number;
  isCompleted: boolean;
  notesPlaced: number;
  queensPlaced: number;
}
