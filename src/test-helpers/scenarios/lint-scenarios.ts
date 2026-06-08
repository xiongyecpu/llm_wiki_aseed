import type { LintScenario } from "./types"

// NOTE: Structural lint only counts inbound wikilinks from OTHER content
// pages (index.md and log.md are excluded from the slug map). So to avoid
// an "orphan" finding on a page, at least one non-index content page must
// [[link]] to it. Scenario wikis here are built with that in mind.

function page(title: string, body: string): string {
  return `---\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`
}

export const lintScenarios: LintScenario[] = [
  // 1. clean-wiki — fully interlinked, no findings
  {
    name: "structural/clean-wiki",
    description:
      "Two content pages cross-link each other. No orphans, no broken " +
      "links, no no-outlinks. Structural lint returns an empty result.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "See the [[transformer]] architecture for how this is applied.",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "Transformers are built on the [[attention]] mechanism.",
      ),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/title-style-wikilinks",
    description:
      "Title-style wikilinks with spaces, punctuation, and case differences " +
      "resolve to existing kebab-case filenames instead of being reported as broken.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[Zwift Ride]]\n- [[Zwift Click]]\n- [[ANT+ FE-C协议]]\n",
      "wiki/zwift-ride.md": page(
        "Zwift Ride",
        "Pairs with [[Zwift Click]] and uses [[ANT+ FE-C协议]].",
      ),
      "wiki/zwift-click.md": page(
        "Zwift Click",
        "Controls [[Zwift Ride]] through the ecosystem.",
      ),
      "wiki/ant-fe-c协议.md": page(
        "ANT+ FE-C协议",
        "Interactive trainer control protocol used by [[Zwift Ride]].",
      ),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/dated-entity-concept-link",
    description:
      "Legacy entity/concept wikilinks that include generated date suffixes " +
      "resolve to the stable undated page when that page exists.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[concepts/遗产产品]]\n- [[concepts/定价悖论]]\n",
      "wiki/concepts/遗产产品.md": page(
        "遗产产品",
        "Legacy products shape [[concepts/定价悖论-2026-06-05-232551]].",
      ),
      "wiki/concepts/定价悖论.md": page(
        "定价悖论",
        "Related to [[concepts/遗产产品-2026-06-05-232551]].",
      ),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/related-frontmatter-counts-as-outlink",
    description:
      "Pages whose relationships are stored in frontmatter related[] have outgoing links " +
      "even when their body contains no explicit wikilinks.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[department]]\n- [[strategy]]\n",
      "wiki/department.md": [
        "---",
        "title: Department",
        "related: [strategy]",
        "---",
        "",
        "# Department",
        "",
        "This page has prose but no body wikilinks.",
        "",
      ].join("\n"),
      "wiki/strategy.md": page("Strategy", "Connected back to [[department]]."),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/related-frontmatter-does-not-create-broken-link",
    description:
      "A missing related[] target should not be reported as a prose broken-link; " +
      "related[] is used for connectivity while body wikilinks remain the broken-link surface.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[profile]]\n- [[hub]]\n",
      "wiki/profile.md": [
        "---",
        "title: Profile",
        "related: [hub, missing-team]",
        "---",
        "",
        "# Profile",
        "",
        "This profile has no body wikilinks, but it has a related entry.",
        "",
      ].join("\n"),
      "wiki/hub.md": page("Hub", "Connected to [[profile]]."),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/separator-variant-wikilinks",
    description:
      "Historical mixed CJK/Latin slug variants with extra separators resolve to the same page.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[ai智能体智能副将domestique]]\n- [[deepseek]]\n",
      "wiki/ai智能体智能副将domestique.md": page(
        "AI智能体智能副将Domestique",
        "Uses [[deepseek]] as a model.",
      ),
      "wiki/deepseek.md": page(
        "DeepSeek",
        "Supports [[ai智能体-智能副将-domestique]].",
      ),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/source-and-query-not-orphans",
    description:
      "Source summaries and query pages are support artifacts; orphan lint should focus on knowledge pages.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Related to [[transformer]].",
      ),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
      "wiki/sources/source-summary.md": page(
        "Source Summary",
        "This source summary has no inbound links from content pages.",
      ),
      "wiki/queries/research-question.md": page(
        "Research Question",
        "This query page has no inbound links from content pages.",
      ),
    },
    expected: {
      structural: [],
    },
  },

  {
    name: "structural/frontmatter-title-resolves-wikilink",
    description:
      "A wikilink may target a human-readable page title while the file uses an encoded or generated slug.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[concept]]\n",
      "wiki/sources/4-lark--encoded-title.md": [
        "---",
        "type: source",
        "title: 顽鹿 BU AI 原生组织架构方案 v2.2",
        "related: [concept]",
        "---",
        "",
        "# 顽鹿 BU AI 原生组织架构方案 v2.2",
        "",
        "Source summary.",
        "",
      ].join("\n"),
      "wiki/concept.md": page(
        "Concept",
        "This concept came from [[顽鹿BU AI原生组织架构方案v2.2]].",
      ),
    },
    expected: {
      structural: [],
    },
  },

  // 2. orphan-page — no inbound wikilinks
  {
    name: "structural/orphan-page",
    description:
      "orphan.md links out to attention.md but no content page links BACK " +
      "to orphan.md. Structural lint should flag it as orphan, nothing else.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
      "wiki/orphan.md": page(
        "Orphan",
        "This page links to [[attention]] but nobody links back here.",
      ),
    },
    expected: {
      structural: [{ type: "orphan", page: "orphan.md" }],
    },
  },

  // 3. broken-link — wikilink to a page that doesn't exist
  {
    name: "structural/broken-link",
    description:
      "attention.md contains a wikilink to [[nonexistent-page]] which has " +
      "no corresponding file. Structural lint must flag the broken link " +
      "and name it in the detail.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Related to [[transformer]] and also to [[nonexistent-page]].",
      ),
      "wiki/transformer.md": page("Transformer", "Built on [[attention]]."),
    },
    expected: {
      structural: [
        {
          type: "broken-link",
          page: "attention.md",
          linkName: "nonexistent-page",
        },
      ],
    },
  },

  // 4. no-outlinks — a page has zero [[wikilinks]]
  {
    name: "structural/no-outlinks",
    description:
      "leaf.md is linked-to by transformer.md but has no outgoing links " +
      "of its own. Lint should flag 'no-outlinks' on leaf.md.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n- [[leaf]]\n",
      "wiki/attention.md": page("Attention", "Related: [[transformer]]."),
      "wiki/transformer.md": page(
        "Transformer",
        "Uses [[attention]] and references [[leaf]] as a concept.",
      ),
      "wiki/leaf.md": page(
        "Leaf",
        "This page describes a leaf concept and makes no external references.",
      ),
    },
    expected: {
      // Only the no-outlinks finding — transformer still outlinks, attention
      // still outlinks, leaf has inbound from transformer.
      structural: [{ type: "no-outlinks", page: "leaf.md" }],
    },
  },

  // 5. semantic-contradiction (LLM-backed)
  {
    name: "semantic/contradiction-found",
    description:
      "Two cross-linked pages make conflicting claims. Structural lint " +
      "sees no issues, but the mocked semantic LLM response emits a LINT " +
      "block that the parser extracts into a contradiction finding.",
    initialWiki: {
      "wiki/index.md": "# Index\n\n- [[attention]]\n- [[transformer]]\n",
      "wiki/attention.md": page(
        "Attention",
        "Attention ALWAYS uses the softmax function. See [[transformer]].",
      ),
      "wiki/transformer.md": page(
        "Transformer",
        "The transformer's [[attention]] layer uses a linear kernel, not softmax.",
      ),
    },
    llmResponse: [
      "Reviewing the pages I found one contradiction:",
      "",
      "---LINT: contradiction | warning | Attention function differs between pages---",
      "attention.md claims softmax is always used, but transformer.md describes a",
      "linear attention kernel. One page needs correction.",
      "PAGES: attention.md, transformer.md",
      "---END LINT---",
    ].join("\n"),
    expected: {
      structural: [],
      semantic: [
        {
          // Parser collapses all semantic findings to type="semantic";
          // the original LLM-declared type ("contradiction") lives in detail.
          type: "semantic",
          severity: "warning",
          titleContains: "Attention function differs",
        },
      ],
    },
  },
]
