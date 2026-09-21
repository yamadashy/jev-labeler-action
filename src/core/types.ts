/** A label as GitHub reports it. `description` is null when the maintainer never wrote one. */
export interface RepoLabel {
  name: string;
  description: string | null;
}

/**
 * The thing being labelled, already extracted from the event payload.
 *
 * `kind` exists so that pull requests can be added later without changing the
 * core: everything below this point only reads `title`, `body` and `labels`.
 */
export interface LabelSubject {
  kind: 'issue';
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: SubjectAuthor;
}

export interface SubjectAuthor {
  login: string;
  /**
   * Bot-authored issues are the one place the zero-config questions reliably
   * misfire: a Renovate configuration warning reads exactly like a bug report.
   */
  isBot: boolean;
}

export type SkipReason =
  | 'already-present'
  | 'excluded'
  | 'not-allowlisted'
  | 'no-condition'
  | 'below-threshold'
  | 'no-answer';

export type RowStatus = 'applied' | 'applied-as-fallback' | SkipReason;

/** One line of the job summary table. */
export interface ResultRow {
  label: string;
  /** Null when the label was never sent to Jev. */
  probability: number | null;
  status: RowStatus;
}
