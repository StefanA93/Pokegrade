import { PokemonProvider }    from './pokemon.js'
import { MTGProvider }        from './mtg.js'
import { YGOProvider }        from './yugioh.js'
import { OnePieceProvider }   from './onepiece.js'
import { LorcanaProvider }    from './lorcana.js'
import { DragonBallProvider } from './dragonball.js'

export { TCGProvider }        from './base.js'
export { PokemonProvider }    from './pokemon.js'
export { MTGProvider }        from './mtg.js'
export { YGOProvider }        from './yugioh.js'
export { OnePieceProvider }   from './onepiece.js'
export { LorcanaProvider }    from './lorcana.js'
export { DragonBallProvider } from './dragonball.js'

let _registry = null

function buildRegistry() {
  return {
    pokemon:    new PokemonProvider({ apiKey: process.env.PTCG_API_KEY }),
    mtg:        new MTGProvider(),
    yugioh:     new YGOProvider(),
    onepiece:   new OnePieceProvider({ apiKey: process.env.CARDMARKET_API_KEY }),
    lorcana:    new LorcanaProvider({ apiKey: process.env.CARDMARKET_API_KEY }),
    dragonball: new DragonBallProvider({ apiKey: process.env.TCGAPI_KEY }),
  }
}

export function getProvider(gameId) {
  if (!_registry) _registry = buildRegistry()
  const p = _registry[gameId]
  if (!p) throw new Error(`Unknown game: ${gameId}`)
  return p
}

export function getAllGameIds() {
  return ['pokemon', 'mtg', 'yugioh', 'onepiece', 'lorcana', 'dragonball']
}
