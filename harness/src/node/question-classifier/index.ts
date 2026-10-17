import { BaseNode, getLLMProvider } from "../base";
import type { NodeContext, WorkflowNodeMetadataInput } from "../../types/index";
import type {
  LLMCallSettings,
  LLMChatInput,
  LLMProviderSource,
} from "../../provider/llm/types";
import { WorkflowError } from "../../workflow/errors";

export interface QuestionClassifierCategory<Name extends string = string> {
  name: Name;
  description: string;
}

export type QuestionClassifierOutput<
  Categories extends readonly QuestionClassifierCategory[],
> = Categories[number]["name"] | "";

export interface QuestionClassifierNodeOptions<
  Categories extends readonly QuestionClassifierCategory[],
> {
  name?: string;
  provider: LLMProviderSource;
  categories: Categories;
  userDescription: string;
  system?: string;
  settings?: Omit<LLMCallSettings, "abortSignal">;
  historyLimit?: number;
  metadata?: WorkflowNodeMetadataInput;
}

interface ResolvedQuestionClassifierCategory {
  name: string;
  description: string;
}

export function createQuestionClassifierNode<
  const Categories extends readonly QuestionClassifierCategory[],
>(
  options: QuestionClassifierNodeOptions<Categories>,
): BaseNode<string, QuestionClassifierOutput<Categories>> {
  return new QuestionClassifierNode(options);
}

class QuestionClassifierNode<
  Categories extends readonly QuestionClassifierCategory[],
> extends BaseNode<string, QuestionClassifierOutput<Categories>> {
  private readonly categories: ResolvedQuestionClassifierCategory[];
  private readonly categoryNames: Set<string>;
  private readonly provider: LLMProviderSource;
  private readonly userDescription: string;
  private readonly system?: string;
  private readonly settings: Omit<LLMCallSettings, "abortSignal">;

  constructor(options: QuestionClassifierNodeOptions<Categories>) {
    super({
      name: options.name ?? "question-classifier",
      standardName: "question-classifier",
      historyLimit: options.historyLimit,
      metadata: options.metadata,
    });
    this.categories = resolveCategories(options.categories);
    this.categoryNames = new Set(this.categories.map((category) => category.name));
    this.provider = options.provider;
    this.userDescription = resolveRequiredText(
      options.userDescription,
      "userDescription",
    );
    this.system = options.system;
    this.settings = options.settings ?? {};
  }

  protected async execute(
    question: string,
    context: NodeContext,
  ): Promise<QuestionClassifierOutput<Categories>> {
    const provider = getLLMProvider(context, this.name, this.provider);
    const resolvedQuestion = resolveRequiredText(question, "question");
    const response = await provider.chat(this.createLLMInput(resolvedQuestion));
    const categoryName = response.text.trim();

    if (!this.categoryNames.has(categoryName)) {
      return "" as QuestionClassifierOutput<Categories>;
    }

    return categoryName as QuestionClassifierOutput<Categories>;
  }

  private createLLMInput(question: string): LLMChatInput {
    return {
      temperature: 0,
      maxOutputTokens: 50,
      ...this.settings,
      system: this.system ?? "You are a strict question classifier.",
      prompt: [
        "Classify the question into exactly one allowed category.",
        "Return only the category name. Do not return JSON, markdown, explanations, or extra text.",
        "If no allowed category fits, return an empty string.",
        "",
        "User description:",
        this.userDescription,
        "",
        "Allowed categories:",
        ...this.categories.map((category, index) => {
          return `${index + 1}. ${category.name}: ${category.description}`;
        }),
        "",
        "Question:",
        question,
      ].join("\n"),
    };
  }
}

function resolveCategories(
  categories: readonly QuestionClassifierCategory[],
): ResolvedQuestionClassifierCategory[] {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new WorkflowError({
      type: "input_validation",
      message: "Question classifier categories are required.",
      nodeName: "question-classifier",
    });
  }

  const resolvedCategories = categories.map((category, index) => ({
    name: resolveRequiredText(category?.name, `categories[${index}].name`),
    description: resolveRequiredText(
      category?.description,
      `categories[${index}].description`,
    ),
  }));
  const duplicatedName = findDuplicatedCategoryName(resolvedCategories);

  if (duplicatedName !== undefined) {
    throw new WorkflowError({
      type: "input_validation",
      message: `Question classifier category "${duplicatedName}" is duplicated.`,
      nodeName: "question-classifier",
      metadata: {
        category: duplicatedName,
      },
    });
  }

  return resolvedCategories;
}

function findDuplicatedCategoryName(
  categories: ResolvedQuestionClassifierCategory[],
): string | undefined {
  const names = new Set<string>();

  for (const category of categories) {
    if (names.has(category.name)) {
      return category.name;
    }

    names.add(category.name);
  }

  return undefined;
}

function resolveRequiredText(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowError({
      type: "input_validation",
      message: `Question classifier field "${fieldName}" is required.`,
      nodeName: "question-classifier",
      metadata: {
        field: fieldName,
      },
    });
  }

  return value.trim();
}
