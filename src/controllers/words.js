import {
  assign,
  map,
  filter,
  uniqBy,
} from 'lodash';
import mongoose from 'mongoose';
import removePrefix from '../shared/utils/removePrefix';
import Word from '../models/Word';
import ExampleSuggestion from '../models/ExampleSuggestion';
import { findSearchWord } from '../services/words';
import SuggestionTypes from '../shared/constants/suggestionTypes';
import { NO_PROVIDED_TERM } from '../shared/constants/errorMessages';
import { getDocumentsIds } from '../shared/utils/documentUtils';
import createRegExp from '../shared/utils/createRegExp';
import {
  sortDocsBy,
  packageResponse,
  handleQueries,
  updateDocumentMerge,
} from './utils';
import { searchIgboTextSearch, strictSearchIgboQuery, searchEnglishRegexQuery } from './utils/queries';
import { findWordsWithMatch } from './utils/buildDocs';
import { createExample, executeMergeExample, findExampleByAssociatedWordId } from './examples';
import { deleteWordSuggestionsByOriginalWordId } from './wordSuggestions';
import { sendMergedEmail } from './email';
import { DICTIONARY_APP_URL } from '../config';
import { findUser } from './users';

/* Gets words from JSON dictionary */
export const getWordData = (req, res, next) => {
  try {
    const { keyword } = req.query;
    const searchWord = removePrefix(keyword);
    if (!searchWord) {
      throw new Error(NO_PROVIDED_TERM);
    }
    const regexWord = createRegExp(searchWord);
    return res.send(findSearchWord(regexWord, searchWord));
  } catch (err) {
    return next(err);
  }
};

/* Searches for a word with Igbo stored in MongoDB */
export const searchWordUsingIgbo = async ({ query, searchWord, ...rest }) => {
  const words = await findWordsWithMatch({ match: query, ...rest });
  return sortDocsBy(searchWord, words, 'word');
};

/* Searches for word with English stored in MongoDB */
export const searchWordUsingEnglish = async ({ query, searchWord, ...rest }) => {
  const words = await findWordsWithMatch({ match: query, ...rest });
  return sortDocsBy(searchWord, words, 'definitions[0]');
};

/* Gets words from MongoDB */
export const getWords = async (req, res, next) => {
  try {
    const {
      searchWord,
      regexKeyword,
      range,
      skip,
      limit,
      strict,
      ...rest
    } = handleQueries(req);
    const searchQueries = { searchWord, skip, limit };
    let query = !strict ? searchIgboTextSearch(searchWord, regexKeyword) : strictSearchIgboQuery(searchWord);
    const words = await searchWordUsingIgbo({ query, ...searchQueries });
    if (!words.length) {
      query = searchEnglishRegexQuery(regexKeyword);
      const englishWords = await searchWordUsingEnglish({ query, ...searchQueries });
      return packageResponse({
        res,
        docs: englishWords,
        model: Word,
        query,
        ...rest,
      });
    }
    return packageResponse({
      res,
      docs: words,
      model: Word,
      query,
      ...rest,
    });
  } catch (err) {
    return next(err);
  }
};

/* Returns a word from MongoDB using an id */
export const getWord = async (req, res, next) => {
  try {
    const { id } = req.params;

    const updatedWord = await findWordsWithMatch({ match: { _id: mongoose.Types.ObjectId(id) }, limit: 1 })
      .then(async ([word]) => {
        if (!word) {
          throw new Error('No word exists with the provided id.');
        }
        return word;
      });
    return res.send(updatedWord);
  } catch (err) {
    return next(err);
  }
};

/* Creates Word documents in MongoDB database */
export const createWord = async (data) => {
  const {
    examples,
    word,
    wordClass,
    definitions,
    variations,
    stems,
  } = data;
  const wordData = {
    word,
    wordClass,
    definitions,
    variations,
    stems,
  };
  const newWord = new Word(wordData);
  await newWord.save();

  /* Go through each word's example and create an Example document */
  const savedExamples = map(examples, async (example) => {
    const exampleData = {
      ...example,
      associatedWords: [newWord.id],
    };
    return createExample(exampleData);
  });

  /* Wait for all the Examples to be created and then add them to the Word document */
  const resolvedExamples = await Promise.all(savedExamples);
  const exampleIds = getDocumentsIds(resolvedExamples);
  newWord.examples = exampleIds;
  return newWord.save();
};

const updateSuggestionAfterMerge = async (suggestionDoc, originalWordDoc, mergedBy) => {
  const updatedSuggestionDoc = await updateDocumentMerge(suggestionDoc, originalWordDoc.id, mergedBy);
  const exampleSuggestions = await ExampleSuggestion.find({ associatedWords: suggestionDoc.id });
  await Promise.all(map(exampleSuggestions, async (exampleSuggestion) => {
    const removeSuggestionAssociatedIds = assign(exampleSuggestion);
    /* Before creating new Example from ExampleSuggestion,
     * all associated word suggestion ids must be removed
     */
    removeSuggestionAssociatedIds.associatedWords = filter(
      exampleSuggestion.associatedWords,
      (associatedWord) => associatedWord.toString() !== suggestionDoc.id.toString(),
    );
    if (!removeSuggestionAssociatedIds.associatedWords.includes(originalWordDoc.id)) {
      removeSuggestionAssociatedIds.associatedWords.push(originalWordDoc.id);
    }
    const updatedExampleSuggestion = await removeSuggestionAssociatedIds.save();
    return executeMergeExample(updatedExampleSuggestion.id, mergedBy);
  }));
  return updatedSuggestionDoc.save();
};

/* Merges new data into an existing Word document */
const mergeIntoWord = (suggestionDoc, mergedBy) => (
  Word.findOneAndUpdate({ _id: suggestionDoc.originalWordId }, suggestionDoc.toObject())
    .then(async (originalWord) => {
      if (!originalWord) {
        throw new Error('Word doesn\'t exist');
      }
      await updateSuggestionAfterMerge(suggestionDoc, originalWord.toObject(), mergedBy);
      return (await findWordsWithMatch({ match: { _id: suggestionDoc.originalWordId }, limit: 1 }))[0];
    })
    .catch((error) => {
      throw new Error(error.message);
    })
);

/* Creates a new Word document from an existing WordSuggestion or GenericWord document */
const createWordFromSuggestion = (suggestionDoc, mergedBy) => (
  createWord(suggestionDoc.toObject())
    .then(async (word) => {
      await updateSuggestionAfterMerge(suggestionDoc, word, mergedBy);
      return word;
    })
    .catch(() => {
      throw new Error('An error occurred while saving the new word.');
    })
);

/* Sends confirmation merged email to user if they provided an email */
const handleSendingMergedEmail = async (result) => {
  if (result.authorId) {
    const { email: userEmail } = await findUser(result.authorId);
    if (userEmail) {
      sendMergedEmail({
        to: userEmail,
        suggestionType: SuggestionTypes.WORD,
        submissionLink: `${DICTIONARY_APP_URL}/word?word=${result.word}`,
        ...result,
      });
    }
  }
};

/* Merges the existing WordSuggestion of GenericWord into either a brand
 * new Word document or merges into an existing Word document */
export const mergeWord = async (req, res, next) => {
  try {
    const { user, suggestionDoc } = req;

    const result = suggestionDoc.originalWordId
      ? await mergeIntoWord(suggestionDoc, user.uid)
      : await createWordFromSuggestion(suggestionDoc, user.uid);
    await handleSendingMergedEmail(result);
    return res.send(result);
  } catch (err) {
    return next(err);
  }
};

const findAndUpdateWord = (id, cb) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new Error(!id ? 'No word id provided' : 'Invalid word id provided');
  }

  return Word.findById(id)
    .then(async (word) => {
      if (!word) {
        throw new Error('Word doesn\'t exist');
      }
      return cb(assign(word));
    });
};

/* Updates a Word document in the database */
export const putWord = async (req, res, next) => {
  try {
    const { body: data, params: { id } } = req;
    if (!data.word) {
      throw new Error('Required information is missing, double your provided data.');
    }

    const savedWord = await findAndUpdateWord(id, (word) => {
      const updatedWord = assign(word, data);
      return updatedWord.save();
    });
    return res.send(savedWord);
  } catch (err) {
    return next(err);
  }
};

/* Replaces all instances of oldId inside all of the examples with
 * with the newId */
const replaceWordIdsFromExampleAssociatedWords = (examples, oldId, newId) => (
  Promise.all(map(examples, (example) => {
    const cleanedWordExample = assign(example);
    cleanedWordExample.associatedWords.push(newId);
    cleanedWordExample.associatedWords = uniqBy(
      filter(cleanedWordExample.associatedWords, (associatedWord) => associatedWord.toString() !== oldId.toString()),
      (associatedWord) => associatedWord.toString(),
    );
    return cleanedWordExample.save();
  }))
);

/* Deletes the specified Word document while moving its contents
 * to another Word document, which preserves the original Word
 * document's data */
export const deleteWord = async (req, res, next) => {
  try {
    const { body: data, params: { id: toBeDeletedWordId } } = req;
    const { primaryWordId } = data;

    const {
      word,
      definitions = [],
      variations = [],
      stems = [],
    } = await Word.findById(toBeDeletedWordId);
    const toBeDeletedWordExamples = await findExampleByAssociatedWordId(toBeDeletedWordId);
    const savedCombinedWord = await findAndUpdateWord(primaryWordId, async (combineWord) => {
      const updatedWord = assign(combineWord);
      updatedWord.definitions = uniqBy(
        [...(updatedWord.definitions || []), ...(definitions || [])],
        (definition) => definition,
      );
      updatedWord.variations = uniqBy(
        [...(updatedWord.variations || []), ...(variations || []), word],
        (variation) => variation,
      );
      updatedWord.stems = uniqBy([...(updatedWord.stems || []), ...(stems || [])], (stem) => stem);

      /* Deletes the specified word and connected wordSuggestions regardless of their merged status */
      await Word.deleteOne({ _id: toBeDeletedWordId });
      await deleteWordSuggestionsByOriginalWordId(toBeDeletedWordId);
      await replaceWordIdsFromExampleAssociatedWords(toBeDeletedWordExamples, toBeDeletedWordId, primaryWordId);
      // Returns the result
      return updatedWord.save();
    });
    return res.send(savedCombinedWord);
  } catch (err) {
    return next(err);
  }
};
