import { RestEndpointMethodTypes } from "@octokit/plugin-rest-endpoint-methods";
import { Octokit } from "@octokit/rest";
import _projects from "../projects.json";
import opt from "../opt.json";
import { Statistics } from "../types/statistics";
import { writeFile } from "fs/promises";
import twitter from "./twitter";

export type GitHubIssue = RestEndpointMethodTypes["issues"]["get"]["response"]["data"];
export type GitHubLabel = RestEndpointMethodTypes["issues"]["listLabelsOnIssue"]["response"]["data"][0];

export type StateChanges<T extends string = "open" | "closed"> = {
  [key: string]: {
    cause: boolean;
    effect: T;
    comment: string;
  };
};

export const projects = _projects as {
  urls: string[];
  category?: Record<string, string>;
};

export const DEVPOOL_OWNER_NAME = "keyrxng";
export const DEVPOOL_REPO_NAME = "devpool-directory";
export enum LABELS {
  PRICE = "Price",
  UNAVAILABLE = "Unavailable",
}

export const octokit = new Octokit({ auth: process.env.DEVPOOL_GITHUB_API_TOKEN });

//=============
// Helpers
//=============

/**
 * Stops forks from spamming real Ubiquity issues with links to their forks
 * @returns true if the authenticated user is Ubiquity
 */
export async function checkIfForked(user: string) {
  return user !== "ubiquity";
}

/**
 * Returns all issues in a repo
 * @param ownerName owner name
 * @param repoName repo name
 * @returns array of issues
 */
export async function getAllIssues(ownerName: string, repoName: string) {
  // get all project issues (opened and closed)
  let issues: GitHubIssue[] = await octokit.paginate({
    method: "GET",
    url: `/repos/${ownerName}/${repoName}/issues?state=all`,
  });
  // remove PRs from the project issues
  issues = issues.filter((issue) => !issue.pull_request);

  return issues;
}

/**
 * Returns all org repositories urls or owner/repo url
 * @param orgOrRepo org or repository name
 * @returns array of repository urls
 */
export async function getRepoUrls(orgOrRepo: string) {
  const params = orgOrRepo.split("/");
  let repos: string[] = [];
  try {
    switch (params.length) {
      case 1: // org
        try {
          const res = await octokit.paginate("GET /orgs/{org}/repos", {
            org: orgOrRepo,
          });
          repos = res.map((repo) => repo.html_url);
        } catch (error: unknown) {
          console.warn(`Getting ${orgOrRepo} org repositories failed: ${error}`);
          throw error;
        }
        break;
      case 2: // owner/repo
        try {
          const res = await octokit.rest.repos.get({
            owner: params[0],
            repo: params[1],
          });

          if (res.status == 200) {
            repos.push(res.data.html_url);
          } else console.warn(`Getting repo ${params[0]}/${params[1]} failed: ${res.status}`);
        } catch (error: unknown) {
          console.warn(`Getting repo ${params[0]}/${params[1]} failed: ${error}`, error);
          throw error;
        }
        break;
      default:
        console.warn(`Neither org or nor repo GitHub provided: ${orgOrRepo}.`);
    }
  } catch (err) {
    console.error(err);
  }

  return repos;
}

/**
 * Returns array of labels for a devpool issue
 * @param issue issue object
 * @param projectUrl url of the project
 */
export function getDevpoolIssueLabels(issue: GitHubIssue, projectUrl: string) {
  // get owner and repo name from issue's URL because the repo name could be updated
  const [ownerName, repoName] = getRepoCredentials(issue.html_url);

  // default labels
  const devpoolIssueLabels = [
    getIssuePriceLabel(issue), // price
    `Partner: ${ownerName}/${repoName}`, // partner
    `id: ${issue.node_id}`, // id
  ];

  // if project is already assigned then add the "Unavailable" label
  if (issue.assignee?.login) devpoolIssueLabels.push(LABELS.UNAVAILABLE);

  const labels = issue.labels as GitHubLabel[];

  // add all missing labels that exist in a project's issue and don't exist in devpool issue
  for (const projectIssueLabel of labels) {
    // skip the "Price" label in order to not accidentally generate a permit
    if (projectIssueLabel.name.includes("Price")) continue;
    // if project issue label does not exist in devpool issue then add it
    if (!devpoolIssueLabels.includes(projectIssueLabel.name)) devpoolIssueLabels.push(projectIssueLabel.name);
  }

  // if project category for the project is defined, add its category label
  if (projects.category && projectUrl in projects.category) devpoolIssueLabels.push(projects.category[projectUrl]);

  return devpoolIssueLabels;
}

/**
 * Returns issue by label
 * @param issues issues array
 * @param label label string
 */
export function getIssueByLabel(issues: GitHubIssue[], label: string) {
  issues = issues.filter((issue) => {
    const labels = (issue.labels as GitHubLabel[]).filter((obj) => obj.name === label);
    return labels.length > 0;
  });
  return issues.length > 0 ? issues[0] : null;
}

/**
 * Returns label value by label prefix
 * Example: "Partner: my/repo" => "my/repo"
 * Example: "id: 123qwe" => "123qwe"
 * @param issue issue
 * @param labelPrefix label prefix
 */
export function getIssueLabelValue(issue: GitHubIssue, labelPrefix: string) {
  let labelValue = null;
  const labels = issue.labels as GitHubLabel[];
  for (const labelObj of labels) {
    if (labelObj.name.includes(labelPrefix)) {
      labelValue = labelObj.name.split(":")[1].trim();
      break;
    }
  }
  return labelValue;
}

/**
 * Returns price label from an issue
 * @param issue issue object
 * @returns price label
 */
export function getIssuePriceLabel(issue: GitHubIssue) {
  const defaultPriceLabel = "Pricing: not set";
  const labels = issue.labels as GitHubLabel[];
  const priceLabels = labels.filter((label) => label.name.includes("Price:") || label.name.includes("Pricing:"));
  // NOTICE: we rename "Price" to "Pricing" because the bot removes all manually added price labels starting with "Price:"
  return priceLabels.length > 0 ? priceLabels[0].name.replace("Price", "Pricing") : defaultPriceLabel;
}

/**
 * Returns owner and repository names from a project URL
 * @param projectUrl project URL
 * @returns array of owner and repository names
 */
export function getRepoCredentials(projectUrl: string) {
  const urlObject = new URL(projectUrl);
  const urlPath = urlObject.pathname.split("/");
  const ownerName = urlPath[1];
  const repoName = urlPath[2];
  if (!ownerName || !repoName) {
    throw new Error(`Missing owner name or repo name in [${projectUrl}]`);
  }
  return [ownerName, repoName];
}

/**
 * Returns text for social media (twitter, telegram, etc...)
 * @param issue Github issue data
 * @returns Social media text
 * Example:
 * ```
 * 50 USD for <1 Hour
 *
 * https://github.com/ubiquity/pay.ubq.fi/issues/65
 * ```
 */
export function getSocialMediaText(issue: GitHubIssue): string {
  const labels = issue.labels as GitHubLabel[];
  const priceLabel = labels.find((label) => label.name.includes("Pricing: "))?.name.replace("Pricing: ", "");
  const timeLabel = labels.find((label) => label.name.includes("Time: "))?.name.replace("Time: ", "");
  // `issue.body` contains URL to the original issue in partner's project
  // while `issue.html_url` contains URL to the mirrored issue from the devpool directory
  return `${priceLabel} for ${timeLabel}\n\n${issue.body}`;
}

export async function getProjectUrls(opts: typeof opt = opt) {
  const projectUrls = new Set<string>(projects.urls);

  for (const orgOrRepo of opts.in) {
    const urls: string[] = await getRepoUrls(orgOrRepo);
    urls.forEach((url) => projectUrls.add(url));
  }

  for (const orgOrRepo of opts.out) {
    const len = orgOrRepo.split("/").length;

    if (len === 1) {
      //it's an org, delete all org repos in the list
      projectUrls.forEach((url) => {
        if (url.includes(orgOrRepo)) {
          const [owner, repo] = getRepoCredentials(url);
          if (opts.in.includes(`${owner}/${repo}`)) {
            return;
          }
          projectUrls.delete(url);
        }
      });
    } else {
      // it's a repo, delete the repo from the list
      projectUrls.forEach((url) => url.includes(orgOrRepo) && projectUrls.delete(url));
    }
  }

  return projectUrls;
}

// Function to calculate total rewards and tasks statistics
export async function calculateStatistics(issues: GitHubIssue[]) {
  const rewards = {
    notAssigned: 0,
    assigned: 0,
    completed: 0,
    total: 0,
  };

  const tasks = {
    notAssigned: 0,
    assigned: 0,
    completed: 0,
    total: 0,
  };

  issues.forEach((issue) => {
    const labels = issue.labels as GitHubLabel[];
    const isAssigned = labels.find((label) => (label.name as string).includes(LABELS.UNAVAILABLE));
    const isCompleted = issue.state === "closed";

    // Increment tasks statistics
    tasks.total++;
    if (isAssigned) {
      tasks.assigned++;
    } else {
      tasks.notAssigned++;
    }

    if (labels.some((label) => label.name as string)) {
      const priceLabel = labels.find((label) => (label.name as string).includes("Pricing"));
      if (priceLabel) {
        // ignore pricing not set
        if (priceLabel.name === "Pricing: not set") return;

        const price = parseInt((priceLabel.name as string).split(":")[1].trim(), 10);

        if (!isNaN(price)) {
          // Increment rewards statistics, if it is assigned but not completed
          if (isAssigned && !isCompleted) {
            rewards.assigned += price;
          } else if (!isAssigned && !isCompleted) {
            rewards.notAssigned += price;
          }

          // Increment completed rewards statistics
          if (isCompleted) {
            rewards.completed += price;
          }

          rewards.total += price;
        } else {
          console.error(`Price '${priceLabel.name}' is not a valid number in issue: ${issue.number}`);
        }
      }
    }

    // Increment completed tasks statistics
    if (isCompleted) {
      tasks.completed++;
    }
  });

  return { rewards, tasks };
}

export async function writeTotalRewardsToGithub(statistics: Statistics) {
  try {
    const owner = DEVPOOL_OWNER_NAME;
    const repo = DEVPOOL_REPO_NAME;
    const filePath = "total-rewards.json";
    const content = JSON.stringify(statistics, null, 2);

    let sha: string | undefined; // Initialize sha to undefined

    // Get the SHA of the existing file, if it exists
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: filePath,
      });

      if (!Array.isArray(data)) {
        // File exists
        sha = data.sha;
      }
    } catch (error) {
      // File doesn't exist yet
      console.log(`File ${filePath} doesn't exist yet.`);
    }

    // Update or create the file
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: "Update total rewards",
      content: Buffer.from(content).toString("base64"),
      sha, // Pass the SHA if the file exists, to update it
    });

    console.log(`Total rewards written to ${filePath}`);
  } catch (error) {
    console.error(`Error writing total rewards to github file: ${error}`);
    throw error;
  }
}

export async function createDevPoolIssue(projectIssue: GitHubIssue, projectUrl: string, body: string, twitterMap: { [key: string]: string }) {
  // if issue is "closed" then skip it, no need to copy/paste already "closed" issues
  if (projectIssue.state == "closed") return;

  // if the project issue is assigned to someone, then skip it
  if (projectIssue.assignee) return;

  // if issue doesn't have the "Price" label then skip it, no need to pollute repo with draft issues
  if (!(projectIssue.labels as GitHubLabel[]).some((label) => label.name.includes(LABELS.PRICE))) return;

  let createdIssue: Awaited<ReturnType<typeof octokit.rest.issues.create>> | undefined;

  // create a new issue
  try {
    createdIssue = await octokit.rest.issues.create({
      owner: DEVPOOL_OWNER_NAME,
      repo: DEVPOOL_REPO_NAME,
      title: projectIssue.title,
      body,
      labels: getDevpoolIssueLabels(projectIssue, projectUrl),
    });
    console.log(`Created: ${createdIssue.data.html_url} (${projectIssue.html_url})`);
  } catch (err) {
    console.error("Failed to create new issue: ", err);
  }

  if (!createdIssue) {
    console.log("No new issue to tweet about");
    return;
  }

  // post to social media
  try {
    const socialMediaText = getSocialMediaText(createdIssue.data);
    const tweetId = await twitter.postTweet(socialMediaText);

    twitterMap[createdIssue.data.node_id] = tweetId?.id ?? "";
    await writeFile("./twitterMap.json", JSON.stringify(twitterMap));
  } catch (err) {
    console.error("Failed to post tweet: ", err);
  }
}

export async function handleDevPoolIssue(
  projectIssues: GitHubIssue[],
  projectIssue: GitHubIssue,
  projectUrl: string,
  devpoolIssue: GitHubIssue,
  isFork: boolean
) {
  //
  const labelRemoved = getDevpoolIssueLabels(projectIssue, projectUrl).filter((label) => label != LABELS.UNAVAILABLE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originals = devpoolIssue.labels.map((label) => (label as any).name);

  const hasChanges = !areEqual(originals, labelRemoved);

  const metaChanges = {
    // the title of the issue has changed
    title: devpoolIssue.title != projectIssue.title,
    // the issue url has updated
    body: !isFork && devpoolIssue.body != projectIssue.html_url,
    // the price/priority labels have changed
    labels: hasChanges,
  };

  const shouldUpdate = metaChanges.title || metaChanges.body || metaChanges.labels;

  if (shouldUpdate) {
    try {
      // process only the metadata changes
      await octokit.rest.issues.update({
        owner: DEVPOOL_OWNER_NAME,
        repo: DEVPOOL_REPO_NAME,
        issue_number: devpoolIssue.number,
        title: metaChanges.title ? projectIssue.title : devpoolIssue.title,
        body: metaChanges.body && !isFork ? projectIssue.html_url : projectIssue.html_url.replace("https://", "https://www."),
        labels: metaChanges.labels ? labelRemoved : originals,
      });
    } catch (err) {
      console.error(err);
    }

    if (metaChanges.title || metaChanges.body || metaChanges.labels) console.log(`Updated metadata: ${devpoolIssue.html_url} (${projectIssue.html_url})`);
  }

  const hasNoPriceLabels = !(projectIssue.labels as GitHubLabel[]).some((label) => label.name.includes(LABELS.PRICE));

  // these changes will open/close issues
  const stateChanges: StateChanges = {
    // missing in the partners
    forceMissing_Close: {
      cause: !projectIssues.some((projectIssue) => projectIssue.node_id == getIssueLabelValue(devpoolIssue, "id:")),
      effect: "closed",
      comment: "Closed (missing in partners)",
    },
    // no price labels set and open in the devpool
    noPriceLabels_Close: {
      cause: hasNoPriceLabels && devpoolIssue.state == "open",
      effect: "closed",
      comment: "Closed (no price labels)",
    },
    // it's closed, been merged and still open in the devpool
    issueComplete_Close: {
      cause: projectIssue.state == "closed" && devpoolIssue.state == "open" && !!projectIssue.pull_request?.merged_at,
      effect: "closed",
      comment: "Closed (merged)",
    },
    // it's closed, assigned and still open in the devpool
    issueAssignedClosed_Close: {
      cause: projectIssue.state == "closed" && devpoolIssue.state == "open" && !!projectIssue.assignee?.login,
      effect: "closed",
      comment: "Closed (assigned-closed)",
    },
    // it's closed, not merged and still open in the devpool
    issueClosed_Close: {
      cause: projectIssue.state == "closed" && devpoolIssue.state == "open",
      effect: "closed",
      comment: "Closed (not merged)",
    },

    // it's open, assigned and still open in the devpool
    issueAssignedOpen_Close: {
      cause: projectIssue.state == "open" && devpoolIssue.state == "open" && !!projectIssue.assignee?.login,
      effect: "closed",
      comment: "Closed (assigned-open)",
    },
    // it's open, merged, unassigned and closed in the devpool
    issueReopenedMerged_Open: {
      cause:
        projectIssue.state == "open" &&
        devpoolIssue.state == "closed" &&
        !!projectIssue.pull_request?.merged_at &&
        !hasNoPriceLabels &&
        !projectIssue.assignee?.login,
      effect: "open",
      comment: "Reopened (merged)",
    },
    // it's open, unassigned and closed in the devpool
    issueUnassigned_Open: {
      cause: projectIssue.state == "open" && devpoolIssue.state == "closed" && !projectIssue.assignee?.login && !hasNoPriceLabels,
      effect: "open",
      comment: "Reopened (unassigned)",
    },
  };

  let newState: "open" | "closed" | undefined = undefined;

  // then process the state changes
  for (const [, value] of Object.entries(stateChanges)) {
    // if the cause is true and the effect is different from the current state
    if (value.cause && devpoolIssue.state != value.effect) {
      // if the new state is already set, then skip it
      if (newState && newState == value.effect) {
        continue;
      }

      try {
        await octokit.rest.issues.update({
          owner: DEVPOOL_OWNER_NAME,
          repo: DEVPOOL_REPO_NAME,
          issue_number: devpoolIssue.number,
          state: value.effect,
        });

        console.log(`Updated state: (${value.comment})\n${devpoolIssue.html_url} - (${projectIssue.html_url})`);
        newState = value.effect;
      } catch (err) {
        console.log(err);
      }
    }
  }
}

function areEqual(a: string[], b: string[]) {
  return a.sort().join(",") === b.sort().join(",");
}
