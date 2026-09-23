/** A label as GitHub reports it. `description` is null when the maintainer never wrote one. */
export interface RepoLabel {
  name: string;
  description: string | null;
}

export type SubjectKind = 'issue' | 'pull_request';

/** One entry of a pull request's changed-file list. */
export interface ChangedFile {
  path: string;
  /** GitHub's own word: added, modified, removed, renamed, copied, changed, unchanged. */
  status: string;
  /** The unified diff, present only when a diff budget was given. */
  patch?: string;
}

/** The thing being labelled, already extracted from the event payload. */
export interface LabelSubject {
  kind: SubjectKind;
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: SubjectAuthor;
  /** Pull requests only. */
  files?: ChangedFile[];
}

export interface SubjectAuthor {
  login: string;
  /**
   * Bot-authored issues are the one place the zero-config questions reliably
   * misfire: a Renovate configuration warning reads exactly like a bug report.
   * Bot pull requests are the same story, and get their labels from the bot.
   */
  isBot: boolean;
}

export type SkipReason = 'already-present' | 'excluded' | 'not-allowlisted' | 'below-threshold' | 'no-answer';

export type RowStatus = 'applied' | 'applied-as-fallback' | SkipReason;

/** One line of the job summary table. */
export interface ResultRow {
  label: string;
  /** Null when the label was never sent to Jev. */
  probability: number | null;
  status: RowStatus;
}
