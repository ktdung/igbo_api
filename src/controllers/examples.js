import mongoose from 'mongoose';
import {
  assign,
  some,
  map,
  trim,
  uniq,
} from 'lodash';
import Example from '../models/Example';
import Word from '../models/Word';
import SuggestionTypes from '../shared/constants/suggestionTypes';
import { DICTIONARY_APP_URL } from '../config';
import { packageResponse, handleQueries, updateDocumentMerge } from './utils';
import { searchExamplesRegexQuery } from './utils/queries';
import { findExampleSuggestionById } from './exampleSuggestions';
import { sendMergedEmail } from './email';
import { findUser } from './users';

/* Create a new Example object in MongoDB */
export const createExample = (data) => {
  const example = new Example(data);
  return example.save();
};

/* Uses regex to search for examples with both Igbo and English */
const searchExamples = ({ query, skip, limit }) => (
  Example
    .find(query)
    .skip(skip)
    .limit(limit)
);

/* Returns examples from MongoDB */
export const getExamples = async (req, res, next) => {
  try {
    const {
      regexKeyword,
      skip,
      limit,
      ...rest
    } = handleQueries(req);
    const regexMatch = searchExamplesRegexQuery(regexKeyword);
    const examples = await searchExamples({ query: regexMatch, skip, limit });

    return packageResponse({
      res,
      docs: examples,
      model: Example,
      query: regexMatch,
      ...rest,
    });
  } catch (err) {
    return next(err);
  }
};

export const findExampleById = (id) => (
  Example.findById(id)
);

export const findExampleByAssociatedWordId = (id) => (
  Example.find({ associatedWords: { $in: [id] } })
);

/* Returns an example from MongoDB using an id */
export const getExample = async (req, res, next) => {
  try {
    const { id } = req.params;
    const foundExample = await findExampleById(id)
      .then((example) => {
        if (!example) {
          throw new Error('No example exists with the provided id.');
        }
        return example;
      });
    return res.send(foundExample);
  } catch (err) {
    return next(err);
  }
};

/* Merges new data into an existing Example document */
const mergeIntoExample = (exampleSuggestion, mergedBy) => (
  Example.findOneAndUpdate({ _id: exampleSuggestion.originalExampleId }, exampleSuggestion.toObject())
    .then(async (example) => {
      if (!example) {
        throw new Error('Example doesn\'t exist');
      }
      await updateDocumentMerge(exampleSuggestion, example.id, mergedBy);
      return example;
    })
);

/* Creates a new Example document from an existing ExampleSuggestion document */
const createExampleFromSuggestion = (exampleSuggestion, mergedBy) => (
  createExample(exampleSuggestion.toObject())
    .then(async (example) => {
      await updateDocumentMerge(exampleSuggestion, example.id, mergedBy);
      return example;
    })
    .catch(() => {
      throw new Error('An error occurred while saving the new example.');
    })
);

/* Executes the logic describe the mergeExample function description */
export const executeMergeExample = async (exampleSuggestionId, mergedBy) => {
  const exampleSuggestion = await findExampleSuggestionById(exampleSuggestionId);

  if (!exampleSuggestion) {
    throw new Error('There is no associated example suggestion, double check your provided data');
  }

  if (!exampleSuggestion.igbo && !exampleSuggestion.english) {
    throw new Error('Required information is missing, double check your provided data');
  }

  if (some(exampleSuggestion.associatedWords, (associatedWord) => !mongoose.Types.ObjectId.isValid(associatedWord))) {
    throw new Error('Invalid id found in associatedWords');
  }

  await Promise.all(
    map(exampleSuggestion.associatedWords, async (associatedWordId) => {
      if (!(await Word.findById(associatedWordId))) {
        throw new Error('Example suggestion associated words can only contain Word ids before merging');
      }
    }),
  );

  if (exampleSuggestion.associatedWords.length !== uniq(exampleSuggestion.associatedWords).length) {
    throw new Error('Duplicates are not allows in associated words');
  }

  return exampleSuggestion.originalExampleId
    ? mergeIntoExample(exampleSuggestion, mergedBy)
    : createExampleFromSuggestion(exampleSuggestion, mergedBy);
};

/* Sends confirmation merged email to user if they provided an email */
const handleSendingMergedEmail = async (result) => {
  if (result.authorId) {
    const { email: userEmail } = await findUser(result.authorId);
    const word = await Word.findById(result.associatedWords[0] || null) || {};
    if (userEmail) {
      sendMergedEmail({
        to: userEmail,
        suggestionType: SuggestionTypes.EXAMPLE,
        submissionLink: `${DICTIONARY_APP_URL}/word?word=${word.word}`,
        ...result,
      });
    }
  }
};

/* Merges the existing ExampleSuggestion into either a brand
 * new Example document or merges into an existing Example document */
export const mergeExample = async (req, res, next) => {
  try {
    const { body: data } = req;
    const { user } = req;

    const exampleSuggestion = await findExampleSuggestionById(data.id);
    const result = await executeMergeExample(exampleSuggestion.id, user.uid);
    await handleSendingMergedEmail(result);
    return res.send(result);
  } catch (err) {
    return next(err);
  }
};

/* Updates an Example document in the database */
export const putExample = async (req, res, next) => {
  try {
    const { body: data, params: { id } } = req;

    if (!data.igbo && !data.english) {
      return next(new Error('Required information is missing, double check your provided data'));
    }

    if (!Array.isArray(data.associatedWords)) {
      data.associatedWords = map(data.associatedWords.split(','), (associatedWord) => trim(associatedWord));
    }

    if (some(data.associatedWords, (associatedWord) => !mongoose.Types.ObjectId.isValid(associatedWord))) {
      return next(new Error('Invalid id found in associatedWords'));
    }

    if (data.associatedWords && data.associatedWords.length !== uniq(data.associatedWords).length) {
      return next(new Error('Duplicates are not allows in associated words'));
    }

    const savedExample = await findExampleById(id)
      .then(async (example) => {
        if (!example) {
          throw new Error('Example doesn\'t exist');
        }
        const updatedExample = assign(example, data);
        return updatedExample.save();
      });
    return res.send(savedExample);
  } catch (err) {
    return next(err);
  }
};
