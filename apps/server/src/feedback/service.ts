import type {
  FeedbackRepositoryPort,
  NewFeedback,
} from "./types.js";

export interface FeedbackServiceOptions {
  repository: FeedbackRepositoryPort;
}

export class FeedbackService {
  constructor(private readonly options: FeedbackServiceOptions) {}

  async submit(input: NewFeedback): Promise<{ feedbackId: string }> {
    const record = await this.options.repository.create(input);
    return { feedbackId: record.id };
  }
}
