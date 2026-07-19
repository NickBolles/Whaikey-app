/**
 * Whiskey School curriculum: hand-curated micro-lessons (2–3 minute reads),
 * end-of-lesson quizzes, and per-wedge flavor education keyed to the shared
 * flavor-wheel taxonomy (src/lib/flavor-wheel.ts). Static, reviewed content —
 * no AI generation here (see docs/FEATURES.md §10.1: AI may personalize
 * ordering later, but never invents facts into lessons).
 *
 * Guardrails: lessons teach attention and vocabulary, never consumption.
 * Progress is knowledge-based (lessons finished), never pours poured.
 */

export interface QuizQuestion {
  prompt: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}

export interface LessonSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface KeyTerm {
  term: string;
  definition: string;
}

export interface Lesson {
  slug: string;
  title: string;
  emoji: string;
  minutes: number;
  teaser: string;
  sections: LessonSection[];
  keyTerms: KeyTerm[];
  quiz: QuizQuestion[];
  /** Wedge ids from FLAVOR_WHEEL this lesson illuminates (links to the explorer). */
  relatedWedgeIds?: string[];
}

export interface Track {
  id: string;
  title: string;
  description: string;
  lessons: Lesson[];
}

export const TRACKS: Track[] = [
  {
    id: "whiskey-101",
    title: "Whiskey 101",
    description: "The foundation: what whiskey is, the major styles, and how to taste with intent.",
    lessons: [
      {
        slug: "what-is-whiskey",
        title: "What is whiskey, anyway?",
        emoji: "🌾",
        minutes: 3,
        teaser: "Grain, water, yeast, oak, and time — the five ingredients behind every bottle.",
        sections: [
          {
            heading: "Grain, water, yeast, time",
            paragraphs: [
              "Whiskey is a spirit distilled from fermented grain and aged in oak barrels. Which grain, which still, which barrel, and how long — those four choices explain most of what ends up in your glass.",
              "That grain requirement is what separates whiskey from its cousins: brandy starts from grapes, rum from sugarcane, tequila from agave. If it didn't start as a cereal grain, it isn't whiskey.",
            ],
          },
          {
            heading: "From field to cask",
            paragraphs: ["Every distillery walks the same five steps, and each one leaves fingerprints on the flavor:"],
            bullets: [
              "Malting & mashing — grains are milled and cooked in hot water so their starches convert to fermentable sugars.",
              "Fermentation — yeast turns that sugary mash into a beer-strength liquid called the wash, creating fruity and floral compounds along the way.",
              "Distillation — the wash is boiled in pot or column stills to concentrate alcohol and flavor; the distiller keeps the good middle of the run and cuts away the harsh ends.",
              "Maturation — the clear new-make spirit rests in oak, picking up all of its color and a huge share of its flavor.",
              "Bottling — the whiskey is usually diluted to bottling strength, sometimes filtered, and sealed up for you.",
            ],
          },
          {
            heading: "Why the barrel gets the credit",
            paragraphs: [
              "Distillers argue about the exact share, but most agree the cask contributes more flavor than any other single step — and every bit of the color. Vanilla, caramel, coconut, and baking spice largely come from oak, not grain.",
              "Time in wood is also where whiskey loses volume to evaporation — the poetic \"angel's share\" — which is part of why older bottlings cost more.",
            ],
          },
          {
            heading: "Whiskey vs. whisky",
            paragraphs: [
              "Both spellings are correct — it's geography, not quality. The United States and Ireland usually write \"whiskey\"; Scotland, Japan, and Canada write \"whisky\". Whaikey uses \"whiskey\" as the umbrella and respects each bottle's own label.",
            ],
          },
        ],
        keyTerms: [
          { term: "Mash", definition: "The porridge of milled grain and hot water that fermentation starts from." },
          { term: "Wash", definition: "The beer-strength liquid produced by fermenting the mash — what actually gets distilled." },
          { term: "New make", definition: "Clear spirit straight off the still, before any barrel time." },
          { term: "Angel's share", definition: "The portion of whiskey lost to evaporation while it ages in the cask." },
        ],
        quiz: [
          {
            prompt: "Every whiskey, no matter the country, must be made from…",
            options: ["Grapes", "Cereal grain", "Sugarcane", "Agave"],
            answerIndex: 1,
            explanation: "Grain is the defining ingredient. Grapes make brandy, sugarcane makes rum, agave makes tequila.",
          },
          {
            prompt: "Where does a whiskey's color come from?",
            options: ["The grain", "The yeast", "The oak cask", "Added dye in all cases"],
            answerIndex: 2,
            explanation: "New-make spirit is clear. All of the natural color — and much of the flavor — comes from time in oak.",
          },
          {
            prompt: "\"New make\" is…",
            options: [
              "A whiskey released this year",
              "Spirit straight off the still, before aging",
              "A first-fill barrel",
              "A young master distiller",
            ],
            answerIndex: 1,
            explanation: "New make is the clear, unaged spirit that goes into the barrel — legally not yet whiskey in most places.",
          },
        ],
      },
      {
        slug: "major-styles",
        title: "Bourbon, Scotch & the style map",
        emoji: "🗺️",
        minutes: 3,
        teaser: "A style is a set of rules plus a place. Here's the map of the big ones.",
        sections: [
          {
            heading: "Style = rules + place",
            paragraphs: [
              "Most famous whiskey styles are legal definitions: what grain, what barrel, where it's made, and for how long. Learn a handful of rules and labels start reading themselves.",
            ],
          },
          {
            heading: "The American branch",
            paragraphs: ["American styles are defined mainly by the mash bill — the recipe of grains:"],
            bullets: [
              "Bourbon — at least 51% corn, aged in new charred-oak containers, made in the USA. Sweet, rounded: caramel, vanilla, baking spice.",
              "Rye — at least 51% rye grain. Spicier and drier: black pepper, mint, rye bread.",
              "Wheated bourbon — swaps the rye portion for wheat, which reads softer and rounder in the glass.",
              "Tennessee whiskey — meets bourbon's rules, then adds charcoal mellowing (the Lincoln County Process) before barreling.",
            ],
          },
          {
            heading: "The Scotch branch",
            paragraphs: [
              "Scotch must be made in Scotland and aged at least three years in oak. Single malt means 100% malted barley from one distillery, batch-distilled in pot stills. Blended Scotch marries malt whisky with lighter grain whisky — smooth, approachable, and the majority of what the world drinks.",
            ],
          },
          {
            heading: "Ireland, Japan & beyond",
            paragraphs: [
              "Irish whiskey is often (not always) triple-distilled, and its signature single pot still style mixes malted and unmalted barley for a creamy, spicy character. Japanese whisky grew from the Scotch tradition and prizes blending and balance. Canadian whisky is often labeled \"rye\" by tradition, and excellent \"world whisky\" now comes from India, Taiwan, Australia, and further afield.",
            ],
          },
        ],
        keyTerms: [
          { term: "Mash bill", definition: "The recipe of grains a whiskey is made from — e.g. 75% corn, 15% rye, 10% malted barley." },
          { term: "Single malt", definition: "Whisky from 100% malted barley made at a single distillery — not from a single barrel." },
          { term: "Blend", definition: "A marriage of whiskies — in Scotch, malt whisky plus lighter grain whisky." },
          { term: "Lincoln County Process", definition: "Filtering new spirit through sugar-maple charcoal — the Tennessee whiskey step." },
        ],
        quiz: [
          {
            prompt: "Bourbon must be aged in…",
            options: ["Used sherry casks", "New charred oak", "Steel tanks", "Any wooden barrel"],
            answerIndex: 1,
            explanation: "New charred oak is non-negotiable for bourbon — it's where all that caramel and vanilla comes from.",
          },
          {
            prompt: "\"Single malt\" means…",
            options: [
              "Whisky from a single barrel",
              "Whisky made only once",
              "100% malted barley from one distillery",
              "Whisky with one flavor note",
            ],
            answerIndex: 2,
            explanation: "Single refers to the distillery, malt to the grain. One single malt bottling usually blends many casks.",
          },
          {
            prompt: "What extra step defines Tennessee whiskey?",
            options: [
              "Triple distillation",
              "Charcoal mellowing before barreling",
              "Aging at sea",
              "Peat-smoked grain",
            ],
            answerIndex: 1,
            explanation: "The Lincoln County Process — filtering through sugar-maple charcoal — comes on top of bourbon's rules.",
          },
        ],
      },
      {
        slug: "read-the-label",
        title: "How to read a whiskey label",
        emoji: "🏷️",
        minutes: 3,
        teaser: "Age statements, proof, bottled-in-bond — which words carry legal weight and which are just marketing.",
        sections: [
          {
            heading: "The age statement",
            paragraphs: [
              "An age statement is the age of the youngest whiskey in the bottle — a 12-year Scotch may contain much older casks, never younger. \"NAS\" (no age statement) bottles simply don't disclose it, which isn't automatically a red flag.",
              "Older doesn't mean better. It means more cask influence and more evaporation — sometimes glorious, sometimes over-oaked. Let your palate, not the number, decide.",
            ],
          },
          {
            heading: "Proof & ABV",
            paragraphs: [
              "ABV is the percentage of alcohol by volume; US proof is simply double the ABV, so 90 proof = 45%. Most whiskey is bottled between 40% and 46%; cask strength means it went to the bottle undiluted, often north of 55%.",
            ],
          },
          {
            heading: "Words that mean something",
            paragraphs: ["A few label terms are legally defined and genuinely informative:"],
            bullets: [
              "Bottled-in-bond — one US distillery, one distilling season, at least 4 years old, exactly 100 proof.",
              "Single barrel — the bottle came from one individual cask, so expect variation between barrels.",
              "Cask strength / barrel proof — no water added before bottling.",
              "Non-chill filtered — skips a cosmetic filtering step; fans say it preserves texture and flavor.",
              "Natural color — no E150a caramel coloring added (Scotch is allowed to add it; bourbon is not).",
            ],
          },
          {
            heading: "Words that mostly don't",
            paragraphs: [
              "\"Handcrafted\", \"reserve\", \"select\", \"rare\", and (in the US) \"small batch\" have no legal definition. They aren't lies, exactly — they're vibes. Price them accordingly.",
            ],
          },
        ],
        keyTerms: [
          { term: "NAS", definition: "No age statement — the bottle doesn't disclose the age of its youngest whiskey." },
          { term: "Cask strength", definition: "Bottled at barrel proof, with no dilution water added." },
          { term: "Chill filtration", definition: "Chilling and filtering whiskey so it won't go hazy — cosmetic, and skipped by many craft bottlers." },
          { term: "Bottled-in-bond", definition: "US designation: one distillery, one season, 4+ years old, exactly 100 proof." },
        ],
        quiz: [
          {
            prompt: "A \"12 years old\" label means…",
            options: [
              "Every drop is exactly 12 years old",
              "The average age is 12",
              "The youngest whiskey inside is 12",
              "The recipe is 12 years old",
            ],
            answerIndex: 2,
            explanation: "Age statements are a floor, not an average — older casks can be in the mix, younger ones cannot.",
          },
          {
            prompt: "A 90-proof whiskey is…",
            options: ["90% alcohol", "45% ABV", "9% ABV", "Illegal in the US"],
            answerIndex: 1,
            explanation: "US proof is double the ABV, so 90 proof = 45% alcohol by volume.",
          },
          {
            prompt: "Which of these has a strict legal definition?",
            options: ["Handcrafted", "Reserve", "Bottled-in-bond", "Rare"],
            answerIndex: 2,
            explanation: "Bottled-in-bond is tightly regulated. The others are marketing language with no legal meaning.",
          },
        ],
      },
      {
        slug: "how-to-taste",
        title: "How to taste (not just drink)",
        emoji: "👃",
        minutes: 3,
        teaser: "Glassware, nosing, the first-sip reset, and why a few drops of water are your friend.",
        sections: [
          {
            heading: "Set up the glass",
            paragraphs: [
              "A tulip-shaped glass — a Glencairn or copita — narrows at the rim to concentrate aroma; a heavy tumbler lets it escape. Pour small: half an ounce is plenty to learn from, and a rested glass keeps revealing new notes for half an hour.",
              "Keep a glass of water alongside. It resets your palate between sips and keeps the evening about attention, not volume.",
            ],
          },
          {
            heading: "Nose first",
            paragraphs: [
              "Most of flavor is smell, so spend real time here. Bring the glass up gently with your mouth slightly open, and don't inhale hard — ethanol prickle will drown everything on an aggressive first sniff. The second and third passes are where the actual aromas live.",
              "Name whatever you find, even if it sounds silly. \"Banana candy\" and \"grandpa's toolshed\" are legitimate tasting notes — the flavor wheel is there to help you sharpen them, not to grade you.",
            ],
          },
          {
            heading: "The sip",
            paragraphs: [
              "Take a tiny first sip and expect mostly burn — that's your palate calibrating to the alcohol, and it's normal. The second sip is the honest one: let it coat your whole tongue, notice the texture (thin? oily? drying?), then pay attention to the finish — the flavors that linger after you swallow are often the most interesting part.",
            ],
          },
          {
            heading: "Water, rest & pacing",
            paragraphs: [
              "A few drops of water — drops, not a splash — often unlocks aromas the alcohol was holding shut. Add, swirl, re-nose, repeat until it opens up.",
              "Good tasting is slow. Give the glass minutes, not seconds; take notes as you go. And at a big tasting, spitting is completely respectable — professionals do it precisely because they want their judgment intact for the next glass.",
            ],
          },
        ],
        keyTerms: [
          { term: "Finish", definition: "The flavors and sensations that linger after you swallow — short, medium, or seemingly endless." },
          { term: "Mouthfeel", definition: "The texture of the whiskey: thin, creamy, oily, hot, drying." },
          { term: "Palate", definition: "Both your sense of taste and the middle act of a tasting — what the whiskey does in your mouth." },
          { term: "Legs", definition: "The streaks whiskey leaves on the glass. They hint at body and ABV — not quality." },
        ],
        quiz: [
          {
            prompt: "Why a tulip-shaped glass?",
            options: [
              "It holds more whiskey",
              "The narrow rim concentrates aroma",
              "It keeps whiskey colder",
              "Tradition only",
            ],
            answerIndex: 1,
            explanation: "The shape funnels aromas to your nose — and smell is where most of \"taste\" actually happens.",
          },
          {
            prompt: "Why does the second sip taste better than the first?",
            options: [
              "The whiskey has changed",
              "Your palate has calibrated to the alcohol",
              "The glass warmed up",
              "It doesn't — the first sip is the truest",
            ],
            answerIndex: 1,
            explanation: "The first sip mostly registers ethanol. Once your palate adjusts, the real flavors come through.",
          },
          {
            prompt: "Adding a few drops of water to whiskey…",
            options: [
              "Ruins it",
              "Is only for cask-strength bottles",
              "Often opens up hidden aromas",
              "Is required by tradition",
            ],
            answerIndex: 2,
            explanation: "A little dilution changes how aroma compounds behave at the surface — many whiskeys bloom with a few drops.",
          },
        ],
      },
      {
        slug: "flavor-wheel-101",
        title: "Speaking flavor: the wheel",
        emoji: "🎡",
        minutes: 2,
        teaser: "Eight families turn \"it's good\" into notes you can actually compare.",
        relatedWedgeIds: ["fruity", "floral", "grain", "sweet", "woody", "spicy", "peaty", "feinty"],
        sections: [
          {
            heading: "Why a wheel",
            paragraphs: [
              "Flavor is hard to talk about without shared words. The wheel gives you a ladder: start with a broad family (\"fruity\"), then climb to a specific note (\"green apple\"). Over time your notes become comparable — across bottles, and against your past self.",
            ],
          },
          {
            heading: "The eight families",
            paragraphs: ["Whaikey's wheel uses eight core families, each with its own origin story:"],
            bullets: [
              "Fruity — orchard, citrus, and dark fruits, mostly esters born in fermentation.",
              "Floral — heather, rose, fresh grass; the delicate end of the spectrum.",
              "Grain — cereal, malt, fresh bread: the raw material talking.",
              "Sweet — vanilla, caramel, honey; overwhelmingly a gift from the cask.",
              "Woody — oak, char, leather, coffee: structure and age.",
              "Spicy — pepper, cinnamon, clove, from rye grain and oak alike.",
              "Peaty / Smoky — campfire, brine, iodine, from peat-dried malt.",
              "Feinty — the funky depths: leather, wax, musty warehouse. Odd, and often wonderful.",
            ],
          },
          {
            heading: "How to use it",
            paragraphs: [
              "Go broad first, then narrow: pick the family you're sure of, then hunt the specific leaf. Rate intensity honestly — a whisper of smoke and a bonfire are different data points.",
              "Disagreement is normal. Palates differ physiologically, and your \"cherry\" may be someone else's \"raisin\". The goal is your own consistent vocabulary, not the officially correct answer. Explore the wheel below, then practice on your next pour.",
            ],
          },
        ],
        keyTerms: [
          { term: "Ester", definition: "Fruity aroma compounds created mostly during fermentation." },
          { term: "Phenol", definition: "The smoky, medicinal compounds peat smoke deposits on malt." },
          { term: "Vanillin", definition: "The vanilla compound whiskey pulls from toasted oak." },
          { term: "Congener", definition: "Catch-all for the trace compounds that give a spirit its flavor beyond pure alcohol." },
        ],
        quiz: [
          {
            prompt: "Vanilla and caramel notes usually come from…",
            options: ["The grain", "The yeast", "The cask", "Added flavoring"],
            answerIndex: 2,
            explanation: "Toasted and charred oak contributes vanillin and caramelized wood sugars — the cask is the pastry chef.",
          },
          {
            prompt: "Fruity notes are largely created during…",
            options: ["Fermentation", "Bottling", "Chill filtration", "Shipping"],
            answerIndex: 0,
            explanation: "Yeast produces fruity esters while fermenting the wash — long, slow ferments tend to make more of them.",
          },
          {
            prompt: "The best way to use the flavor wheel is…",
            options: [
              "Memorize every leaf before tasting",
              "Start with a broad family, then narrow down",
              "Only use the official notes for each bottle",
              "Pick the rarest-sounding note",
            ],
            answerIndex: 1,
            explanation: "Broad-then-narrow keeps you honest — certainty about the family, curiosity about the leaf.",
          },
        ],
      },
    ],
  },
  {
    id: "going-deeper",
    title: "Going deeper",
    description: "Cask science, proof and water, peat, and the map of Scotland — for when 101 isn't enough.",
    lessons: [
      {
        slug: "barrel-science",
        title: "Cask science: why oak matters",
        emoji: "🛢️",
        minutes: 3,
        teaser: "Toast, char, American vs. European oak, and what \"finishing\" really means.",
        relatedWedgeIds: ["sweet", "woody", "spicy"],
        sections: [
          {
            heading: "Toast & char",
            paragraphs: [
              "Before a barrel is filled it's fired. Toasting gently caramelizes the wood's sugars; charring goes further, blistering the surface into a layer of active charcoal that filters harshness while the caramelized layer underneath feeds the spirit vanilla and toffee. American distillers order char by number — char #3 and the \"alligator\" char #4 are the workhorses.",
            ],
          },
          {
            heading: "American vs. European oak",
            paragraphs: [
              "American white oak gives the classic bourbon voice: vanilla, caramel, coconut, gentle sweetness. European oak — most often met as an ex-sherry cask — brings dried fruit, walnut, baking spice, and grippy tannin. Many great whiskies are a conversation between the two.",
            ],
          },
          {
            heading: "First fill & finishing",
            paragraphs: [
              "Bourbon's new-oak rule means its barrels are used once, then shipped abroad — most Scotch ages in ex-bourbon wood. A first-fill cask gives loudly; each refill speaks more softly.",
              "Finishing means moving matured whiskey into a different cask — sherry, port, rum — for a final stretch of months to layer on extra character. Done well it adds a chapter; done badly it's a costume.",
            ],
          },
          {
            heading: "Climate & time",
            paragraphs: [
              "A Kentucky rickhouse swings hot and cold, pushing spirit in and out of the wood — fast, intense extraction. A cool, damp Scottish dunnage warehouse works slowly and gently. That's why comparing age statements across countries misleads: years are not interchangeable units. Extraction is quick; integration — flavors knitting together — is what actually takes time.",
            ],
          },
        ],
        keyTerms: [
          { term: "First-fill", definition: "A cask holding whiskey for the first time since its original contents — maximum flavor impact." },
          { term: "Finishing", definition: "A short second maturation in a different cask type to layer on extra character." },
          { term: "Tannin", definition: "Grippy, drying compounds from oak — structure in small doses, splinters in excess." },
          { term: "Dunnage", definition: "Traditional low, earth-floored Scottish warehouse — cool, damp, and slow." },
        ],
        quiz: [
          {
            prompt: "Coconut and vanilla notes point to…",
            options: ["European oak", "American white oak", "Steel aging", "Peat smoke"],
            answerIndex: 1,
            explanation: "American white oak is rich in vanillin and coconut-y oak lactones — the bourbon signature.",
          },
          {
            prompt: "An ex-sherry cask typically contributes…",
            options: [
              "Dried fruit, nuts, and baking spice",
              "Smoke and iodine",
              "No flavor at all",
              "Bubblegum and mint",
            ],
            answerIndex: 0,
            explanation: "European oak plus sherry seasoning reads as raisins, figs, walnut, and spice with firmer tannin.",
          },
          {
            prompt: "\"Finished in port casks\" means the whiskey…",
            options: [
              "Was aged entirely in port casks",
              "Had port wine added",
              "Spent a final stretch in port casks after main aging",
              "Was bottled in Portugal",
            ],
            answerIndex: 2,
            explanation: "Finishing is a second, shorter maturation on top of the primary aging — a final coat of flavor.",
          },
        ],
      },
      {
        slug: "proof-water-ice",
        title: "Proof, water & ice",
        emoji: "💧",
        minutes: 2,
        teaser: "What dilution actually does to flavor — and why there's no wrong way to enjoy your glass.",
        sections: [
          {
            heading: "What proof does to flavor",
            paragraphs: [
              "Alcohol is the vehicle that carries aroma to your nose — but at high strength it also anaesthetizes your palate and shouts over the quieter notes. Higher proof means more concentration and more intensity, not automatically more quality.",
            ],
          },
          {
            heading: "The case for a few drops",
            paragraphs: [
              "Adding a little water changes how flavor compounds arrange themselves at the liquid's surface, pushing aroma up and out — which is why a few drops can make a closed whiskey suddenly bloom with fruit and sweetness.",
              "The method matters: drops, not splashes. Add a few, swirl, nose again. You can always add more water; you can't take it out.",
            ],
          },
          {
            heading: "Ice, honestly",
            paragraphs: [
              "Ice chills and dilutes, which mutes aroma — that's physics, not snobbery. It also makes a hot afternoon dram genuinely refreshing. If you like it on the rocks, drink it on the rocks; one large cube melts slower than a handful of small ones. When you're trying to learn a bottle, though, give it a first pass neat.",
            ],
          },
          {
            heading: "Cask strength strategy",
            paragraphs: [
              "Cask-strength bottles hand you the water controls. Start with a small, careful sip neat, then walk it down a few drops at a time — somewhere on that dilution curve is the version of the whiskey you like best, and finding it is half the fun.",
            ],
          },
        ],
        keyTerms: [
          { term: "Proof", definition: "US measure of alcohol strength: double the ABV. 100 proof = 50%." },
          { term: "Dilution", definition: "Adding water — done at the distillery to reach bottling strength, or in your glass to taste." },
          { term: "Neat", definition: "Whiskey served as-is: no water, no ice, no mixer." },
        ],
        quiz: [
          {
            prompt: "A whiskey at 50% ABV is…",
            options: ["25 proof", "50 proof", "100 proof", "200 proof"],
            answerIndex: 2,
            explanation: "US proof doubles the ABV: 50% alcohol by volume is 100 proof.",
          },
          {
            prompt: "A few drops of water in whiskey tend to…",
            options: [
              "Kill the flavor entirely",
              "Push more aroma to the surface",
              "Raise the alcohol content",
              "Only work in bourbon",
            ],
            answerIndex: 1,
            explanation: "Slight dilution rearranges aroma compounds at the surface — many whiskeys open up noticeably.",
          },
          {
            prompt: "Ice in your whiskey…",
            options: [
              "Is always wrong",
              "Mutes aroma but can be exactly what you want",
              "Intensifies the finish",
              "Adds sweetness",
            ],
            answerIndex: 1,
            explanation: "Cold suppresses aroma — a real trade-off, and a completely legitimate choice. Your glass, your call.",
          },
        ],
      },
      {
        slug: "peat-and-smoke",
        title: "Peat, smoke & the maritime malts",
        emoji: "🔥",
        minutes: 3,
        teaser: "What peat actually is, how smoke gets into the glass, and how to learn to love it.",
        relatedWedgeIds: ["peaty"],
        sections: [
          {
            heading: "What peat actually is",
            paragraphs: [
              "Peat is thousands of years of compressed bog vegetation — proto-coal, cut from the ground in bricks and burned for fuel. When a distillery dries its wet malted barley over a peat fire, the smoke's phenolic compounds bind to the grain, and they survive all the way through mashing, fermentation, and distillation into the glass.",
              "So the smoke isn't added to the whiskey — it's baked into the barley before the whiskey exists.",
            ],
          },
          {
            heading: "Measuring smoke",
            paragraphs: [
              "Smokiness is measured in ppm — parts per million of phenols — but on the malted barley, not in the bottle. A \"50 ppm\" malt loses much of that intensity through the process, and cask aging softens it further. Treat ppm as a recipe note, not a promised experience; two 40-ppm whiskies can smoke very differently.",
            ],
          },
          {
            heading: "Where smoke lives",
            paragraphs: [
              "Islay, the little Hebridean island, is peat's spiritual home — its south-shore malts add a maritime edge of brine, seaweed, and iodine to the campfire. Island and Highland peat often reads earthier and more heathery. And peat isn't Scottish property: smoky whiskies now come from Ireland, Japan, India, and the US craft scene.",
            ],
          },
          {
            heading: "Learning to love it",
            paragraphs: [
              "Peat is a spectrum, not a switch. If a full-bore Islay dram reads as a burning hospital, start with lightly peated bottlings and work up — the palate genuinely adapts, and campfire, brine, and medicinal notes start resolving into detail. Many lifelong peat-heads hated their first sip. Give it three tries before you rule.",
            ],
          },
        ],
        keyTerms: [
          { term: "Peat", definition: "Ancient compressed bog vegetation, burned to dry malt — the source of whiskey's smoke." },
          { term: "PPM", definition: "Parts per million of phenols, measured on the malted barley — a recipe spec, not a bottle guarantee." },
          { term: "Kiln", definition: "Where wet malted barley is dried — over peat fire if smoke is the goal." },
          { term: "Maritime", definition: "Seashore character — brine, seaweed, iodine — typical of coastal, especially Islay, malts." },
        ],
        quiz: [
          {
            prompt: "How does smoke get into a peated whisky?",
            options: [
              "Liquid smoke is added before bottling",
              "The barrels are smoked",
              "Malted barley is dried over a peat fire",
              "The water source is smoky",
            ],
            answerIndex: 2,
            explanation: "Phenols from the peat fire bind to the drying malt and ride through the whole process into the glass.",
          },
          {
            prompt: "PPM on a peated whisky measures phenols in…",
            options: ["The finished bottle", "The malted barley", "The barrel", "The water"],
            answerIndex: 1,
            explanation: "PPM is specced on the malt. Much of it is lost in production, so bottle intensity varies.",
          },
          {
            prompt: "The region most famous for peated, maritime whisky is…",
            options: ["Speyside", "Kentucky", "Islay", "The Lowlands"],
            answerIndex: 2,
            explanation: "Islay's malts — especially the south shore — define the briny, medicinal, campfire style.",
          },
        ],
      },
      {
        slug: "scotch-regions",
        title: "The Scotch regions, mapped",
        emoji: "🏔️",
        minutes: 3,
        teaser: "Speyside to Islay: what the regions tell you — and what they don't.",
        relatedWedgeIds: ["fruity", "floral", "peaty"],
        sections: [
          {
            heading: "Five-ish regions",
            paragraphs: [
              "Scotland's whisky map is traditionally carved into five protected regions — Speyside, Highland, Lowland, Islay, and Campbeltown — with the scattered Islands usually folded into the Highlands. Each grew a house style out of its geography, water, and history.",
            ],
          },
          {
            heading: "The tour",
            paragraphs: ["One line each, to get your bearings:"],
            bullets: [
              "Speyside — the densest cluster of distilleries in the world; orchard fruit, honey, and elegant sherried malts.",
              "Highland — the biggest and most varied region: heather and honey in the south, dry spice in the north, salt at the coasts.",
              "Lowland — traditionally gentle, grassy, and light; a classic first-Scotch region.",
              "Islay — peat smoke, brine, and iodine; small island, enormous flavors.",
              "Campbeltown — once \"the whisky capital of the world\", now a tiny, cultish region of oily, briny, lightly funky malts.",
              "Islands — Orkney to Arran: heathery smoke, sea spray, and everything between.",
            ],
          },
          {
            heading: "A compass, not a cage",
            paragraphs: [
              "Regions are a starting guess, not a guarantee: there are unpeated Islay malts, smoky Speysiders, and Lowland distilleries breaking every stereotype. Use the region to orient your first impression — then let the actual liquid overrule the map whenever it wants to.",
            ],
          },
        ],
        keyTerms: [
          { term: "Speyside", definition: "The river-Spey region holding roughly half of Scotland's distilleries." },
          { term: "Campbeltown", definition: "A once-mighty, now tiny region on the Kintyre peninsula — oily, briny, beloved." },
          { term: "Dram", definition: "Scottish for a pour of whisky — unmeasured, but always friendly." },
        ],
        quiz: [
          {
            prompt: "Which region packs in the most distilleries?",
            options: ["Islay", "Speyside", "Lowland", "Campbeltown"],
            answerIndex: 1,
            explanation: "Speyside is the densest whisky region on Earth — home to around half of Scotland's distilleries.",
          },
          {
            prompt: "Islay is famous for…",
            options: [
              "Light, grassy malts",
              "Peaty, maritime malts",
              "Corn-forward whisky",
              "Triple distillation",
            ],
            answerIndex: 1,
            explanation: "Islay means peat smoke, brine, and iodine — the maritime school of Scotch.",
          },
          {
            prompt: "A whisky's region tells you…",
            options: [
              "Exactly how it will taste",
              "Its price",
              "A useful starting guess about its style",
              "Its age",
            ],
            answerIndex: 2,
            explanation: "Regions are a compass, not a cage — expect exceptions, and let the liquid have the last word.",
          },
        ],
      },
    ],
  },
];

/** Per-wedge education for the flavor explorer, keyed by FLAVOR_WHEEL wedge id. */
export interface WedgeNote {
  /** Where the family's flavors come from in production. */
  source: string;
  /** What the family tastes/smells like in the glass. */
  blurb: string;
  /** Styles and situations where the family shows up loudest. */
  spotIt: string;
}

export const WEDGE_NOTES: Record<string, WedgeNote> = {
  fruity: {
    source:
      "Mostly esters created by yeast during fermentation — long, slow ferments make more of them. Dark-fruit notes (raisin, fig, cherry) often point to sherry-cask aging.",
    blurb:
      "The orchard-to-tropics spectrum: crisp green apple and pear, bright citrus, deep cherry and dried fruit, even banana and pineapple.",
    spotIt:
      "Green apple and pear in Irish whiskey and Speyside malts; cherry in bourbon; raisin and fig in sherried Scotch; banana in wheated styles.",
  },
  floral: {
    source:
      "Delicate esters and aldehydes that survive best in lighter spirit — taller stills and gentler distillation keep them alive.",
    blurb: "Heather, rose, lavender, fresh-cut grass, and garden herbs — whiskey at its most perfumed and spring-like.",
    spotIt: "Lowland Scotch, many Irish and Japanese whiskies, and heather-honey Highland malts.",
  },
  grain: {
    source:
      "The raw material speaking: barley, corn, wheat, and rye each leave a cereal signature that's clearest in younger whiskies.",
    blurb: "Malt, biscuit, porridge, fresh bread, sweet corn — the comforting bakery-and-breakfast end of the wheel.",
    spotIt: "Malty single malts, young craft whiskies, sweet corn in bourbon, rye-bread savor in rye whiskey.",
  },
  sweet: {
    source:
      "Overwhelmingly the cask: toasting and charring oak caramelizes wood sugars and creates vanillin, which the spirit drinks back out over the years.",
    blurb: "Vanilla, caramel, toffee, honey, maple, chocolate — the dessert cart of the flavor wheel.",
    spotIt: "Bourbon above all (new charred oak every time), and any whiskey with heavy first-fill cask influence.",
  },
  woody: {
    source:
      "Oak structure — tannin, char, and time. Leather and tobacco notes deepen with long aging and European-oak casks.",
    blurb: "Oak, char, cedar, leather, tobacco, nuts, and coffee: dry, structured, and grown-up.",
    spotIt: "Well-aged whiskies of every style; heavily charred bourbons; old sherried malts drifting into leather and walnut.",
  },
  spicy: {
    source:
      "Two suppliers: rye grain (pepper, mint, baking spice) and oak — especially European oak, whose eugenol reads as clove and cinnamon.",
    blurb: "Black pepper, cinnamon, clove, nutmeg, ginger, anise — warmth and bite that make a whiskey feel alive.",
    spotIt: "Rye whiskey front and center, high-rye bourbons, and sherry-cask Scotch with clove-and-cinnamon oak spice.",
  },
  peaty: {
    source:
      "Phenols from peat smoke, absorbed when malted barley is dried over a peat fire — baked into the grain before distillation ever starts.",
    blurb: "Campfire smoke, earthy peat, brine and seaweed, iodine, ash, tar, and smoked meat — the wild coastal end of whiskey.",
    spotIt: "Islay Scotch famously, island and Highland peated malts, and peated releases from Ireland, Japan, and beyond.",
  },
  feinty: {
    source:
      "Heavier compounds from the tail end of the still run plus long-aging warehouse character — kept in careful doses for depth.",
    blurb: "The funky basement notes: wax, must, meatiness, struck match. Strange on paper, magnetic in a complex old dram.",
    spotIt: "Waxy Highland malts, meaty sherried whiskies, and dunnage-aged bottlings with old-library depth.",
  },
};

const lessonList: Lesson[] = TRACKS.flatMap((t) => t.lessons);
const lessonBySlug = new Map(lessonList.map((l) => [l.slug, l]));
const trackByLessonSlug = new Map(
  TRACKS.flatMap((t) => t.lessons.map((l) => [l.slug, t] as const)),
);

export function allLessons(): Lesson[] {
  return lessonList;
}

export function getLesson(slug: string): Lesson | undefined {
  return lessonBySlug.get(slug);
}

export function getTrackForLesson(slug: string): Track | undefined {
  return trackByLessonSlug.get(slug);
}

/** The lesson after `slug` in curriculum order (crossing track boundaries), if any. */
export function nextLesson(slug: string): Lesson | undefined {
  const i = lessonList.findIndex((l) => l.slug === slug);
  if (i === -1) return undefined;
  return lessonList[i + 1];
}
