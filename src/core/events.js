export const EV = {
  READY: 'ready',
  GOAL: 'player:goal',         // { name, self }
  RESPAWN: 'player:respawn',
  CHECKPOINT: 'player:checkpoint', // { index }
  GRABBED: 'player:grabbed',       // { by } 내가 잡혔을 때
  PEER_JOIN: 'net:join',       // { id, name }
  PEER_LEAVE: 'net:leave',     // { id, name }
  GRAB: 'player:grab',         // { side }
  THROW: 'player:throw',
  JUMP: 'player:jump',
  LAND: 'player:land',
};
