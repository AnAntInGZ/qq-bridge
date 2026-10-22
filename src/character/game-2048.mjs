export const DIRECTIONS = ['up', 'left', 'right', 'down'];
export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== 16 || board.some(value => !Number.isInteger(value) || (value !== 0 && (value < 2 || value > 65536 || (value & (value-1)) !== 0)))) throw new Error('2048 棋盘无效');
  return board;
}
export function move2048(board, direction) {
  validateBoard(board);
  if (!DIRECTIONS.includes(direction)) throw new Error('2048 方向无效');
  const result = [...board]; let gained = 0;
  for (let line = 0; line < 4; line++) {
    const indexes = Array.from({ length: 4 }, (_, n) => direction === 'left' ? line*4+n : direction === 'right' ? line*4+3-n : direction === 'up' ? n*4+line : (3-n)*4+line);
    const values = indexes.map(index => board[index]).filter(Boolean), merged = [];
    for (let i = 0; i < values.length; i++) {
      if (values[i] === values[i+1]) { merged.push(values[i]*2); gained += values[i]*2; i++; }
      else merged.push(values[i]);
    }
    indexes.forEach((index,n) => { result[index] = merged[n] || 0; });
  }
  return { board: result, gained, changed: result.some((value,i) => value !== board[i]) };
}
function evaluate(board) {
  const max = Math.max(...board);
  let score = board.filter(value => !value).length * 250 + Math.log2(max || 1)*20;
  if ([0,3,12,15].some(index => board[index] === max)) score += Math.log2(max || 1)*80;
  for (let r=0;r<4;r++) for(let c=0;c<4;c++) {
    const a = board[r*4+c];
    for (const b of [c<3 ? board[r*4+c+1] : 0, r<3 ? board[(r+1)*4+c] : 0]) if (a && b) score -= Math.abs(Math.log2(a)-Math.log2(b))*12;
  }
  return score;
}
function expected(board, depth) {
  if (!depth) return evaluate(board);
  const empty = board.map((value,index)=>value ? -1 : index).filter(index=>index>=0);
  if (!empty.length) return evaluate(board);
  let sum = 0;
  for (const index of empty) for(const [value,probability] of [[2,0.9],[4,0.1]]) {
    const next = [...board]; next[index]=value;
    const choices=DIRECTIONS.map(direction=>move2048(next,direction)).filter(item=>item.changed);
    sum += probability*(choices.length ? Math.max(...choices.map(item=>item.gained+expected(item.board,depth-1))) : -10000);
  }
  return sum/empty.length;
}
export function choose2048(board) {
  validateBoard(board);
  const choices = DIRECTIONS.map(direction=>({ direction, ...move2048(board,direction) })).filter(item=>item.changed);
  if (!choices.length) return null;
  return choices.map(item=>({ ...item, score: item.gained+expected(item.board,1) })).sort((a,b)=>b.score-a.score)[0];
}
export function legalSuccessor(before, after, direction) {
  validateBoard(after);
  const moved = move2048(before,direction);
  if (!moved.changed) return false;
  const changed = after.map((value,index)=>value !== moved.board[index] ? index : -1).filter(index=>index>=0);
  return changed.length === 1 && moved.board[changed[0]] === 0 && [2,4].includes(after[changed[0]]);
}
