export const EV = {
  READY: 'ready',
  GOAL: 'player:goal',         // { name, self }
  RESPAWN: 'player:respawn',
  PEER_JOIN: 'net:join',       // { id, name }
  PEER_LEAVE: 'net:leave',     // { id, name }
  GRAB: 'player:grab',         // { side }
  THROW: 'player:throw',
  JUMP: 'player:jump',
  LAND: 'player:land',
};
