const debug = require('debug')('codepress:realtime-reporter-helper');
const assert = require('assert');
const scenarioStatusRepository = require('../model/scenario-status-repository');
const snapshotStore = require('../model/snapshot-store');    
const { output, recorder, event, store } = require('codeceptjs');
const wsEvents = require('../model/ws-events');

const {
  toError,
  isRetvalStep,
  isScreenshotStep,
  takeSnapshot,
  filterStack,
  getRetval,
  grabSource
} = require('./reporter-utils');

const mapSuiteAndTest = (startedAt, suite, test) => {
  return {
    startedAt,
    id: test && test.id || suite && suite.id,
    suite: suite && suite.title,
    title: test && test.title,
    file: test && test.file,
    steps: [],
  };
};
const mapArgs = (args) => {
  return args.map(a => {
    if (typeof a === 'function') return a.toString();
    if (typeof a === 'object') {
      if (a.constructor.name === 'Locator') return a.toString();
      if (a.constructor.name === 'Secret') return a.toString();
    } 
    return a;
  });
};

const isEqualMetaStep = (metastep1, metastep2) => {
  if (!metastep1 && !metastep2) return true;
  if (!metastep1 || !metastep2) return false;
  return metastep1.actor === metastep2.actor 
    && metastep1.name === metastep2.name 
    && metastep1.args.join(',') === metastep2.args.join(',');
};

// eslint-disable-next-line no-undef
let Helper = codecept_helper;

/**
 * Report test progress in realtime
 */
class RealtimeReporterHelper extends Helper {
  constructor(options) {
    super(options);

    this.isConnected = false;
    this.stepIndex = 0;
    this.suite = undefined;
    this.test = undefined;
    this.step = undefined;
    this.metaStep = undefined;
    this.nextForceTakeSnapshot = undefined;

    event.dispatcher.on(event.hook.failed, (suite, err) => {
      wsEvents.rtr.testFailed({
        duration: 0,
        error: toError(err),
      });  
      wsEvents.codeceptjs.exit(1);      
    });

    // hot fix for Puppeteer not restarting
    event.dispatcher.on(event.all.result, () => {
      let helper = this._getHelper();
      if (helper) helper.isRunning = false;
    });    

    process.on('unhandledRejection', (err) => {
      output.error('Unhandled rejection', err.toString()); // eslint-ignore-line no-console
      if (!this.test) return;
      wsEvents.rtr.testFailed({
        stepId: this.test.steps.length,
        step: this.step,
        testStartedAt: this.testStartedAt,
        testId: this.test.id,
        duration: (Date.now() - this.testStartedAt) / 1000,
        error: toError(err),
        // snapshot,
      });
      wsEvents.codeceptjs.exit(1);
    });    

    event.dispatcher.on(event.test.failed, (test, err) => {
      if (test.ctx && test.ctx.currentTest) {
        test = test.ctx.currentTest;
      }

      const testStartedAt = this.testStartedAt || Date.now();
      const step = test.steps[test.steps.length - 1];

      this._reportStep(step);

      recorder.add('send test failed event', () => {        
        wsEvents.rtr.testFailed({
          testStartedAt,
          testId: test.id,
          duration: (Date.now() - testStartedAt) / 1000,
          error: toError(err),
        });
      });
    });


    event.dispatcher.on(event.step.comment, (msg) => {
      // console.log('comment', msg);
      // ignore metasteps as comment events
      if (this.metaStep && `${this.metaStep.actor} ${this.metaStep.name}` == msg.trim()) return;
      wsEvents.rtr.stepComment({
        id: this.stepIndex++,
        at: Date.now() - this.testStartedAt,
        actor: 'I',
        name: 'say',
        args: [msg],
        humanized: 'I say',
        snapshot: undefined,
        stack: {}
      });
    });


    event.dispatcher.on(event.step.before, (step) => {
      recorder.add('test started', () => {
        this.stepIndex++;
        this.step = step; // store current step    
        this.stepStartedAt = Date.now();        
        this._emitMetaStepChangedIfNecessary();
        wsEvents.rtr.stepBefore(
          this._mapStep({
            testStartedAt: this.testStartedAt, 
            id: this.stepIndex, 
            step, 
          })
        );
      });
    });

    event.dispatcher.on(event.step.after, (step) => {
      this._reportStep(step);
    });
    
    event.dispatcher.on(event.step.passed, async (step, retvalPromise) => {
      if (isRetvalStep(step) && retvalPromise) {
        const returnValue = await getRetval(step, retvalPromise);

        recorder.add('send result to websockets', () => {
          wsEvents.rtr.stepAfter({
            id: this.stepIndex,
            testId: this.test.id,
            returnValue,
          });
        });        
      }
    });
  }

  _init() {
    debug('init');
  }

  _isEnabled() {
    return true;
  }

  _getHelper() {
    return this.helpers['Appium'] || this.helpers['WebDriver'] || this.helpers['WebDriverIO'] || this.helpers['Puppeteer'] || this.helpers['TestCafe'];
  }

  _generateSection(metaStep, append = false) {
    if (!metaStep) return;
    const line = this._stringifyMetaStep(metaStep);    
    if (append) this.loggedMetaSteps.push(line);
    return line;

  }

  _mapMetaStep(metaStep, isNewSection = false) {
    if (!metaStep) return;

    const result = {
      actor: metaStep.actor,
      name: metaStep.name,
      args: metaStep.args,
    };
    
    if (metaStep.metaStep) { 
      result.metaStep = this._mapMetaStep(metaStep.metaStep, isNewSection);
      result.section = this._generateSection(metaStep.metaStep);
    }

    if (isNewSection) {
      result.opens = this._generateSection(metaStep, false);
    }

    return result;  
  }

  _stringifyMetaStep(metaStep, line = '') {
    if (!metaStep) return line;
    const index = this.loggedMetaSteps.filter(ms => ms === line).length;
    line = `${metaStep.actor.replace(/[\W_]+/g, '') || ''}-${metaStep.name.replace(/[\W_]+/g, '') || ''}${index}_` + line;
    return this._stringifyMetaStep(metaStep.metaStep, line);  
  }  

  _mapStep({testStartedAt, id, step, snapshot }) {
    assert(testStartedAt, 'testStartedAt is required');
    assert(id, 'id is required');
    assert(step, 'step is required');
  
    const stack = Object.assign({ stackFrameInTest: this.cachedStackFrameInTest }, filterStack(step));
    if (!stack.stackFrameInTest) {
      stack.stackFrameInTest = this.cachedStackFrameInTest;
    }
    this.cachedStackFrameInTest = stack.stackFrameInTest;

    if (snapshot) {
      snapshot = Object.assign({}, snapshot);
      delete snapshot.source;
    }

    return {
      id,
      testId: this.test.id,
      at: Date.now() - testStartedAt,
      duration: Date.now() - step.startTime,
      actor: 'I',
      humanized: step.humanize(),
      humanizedArgs: step.humanizeArgs(),
      status: step.status,
      name: step.name,
      args: mapArgs(step.args),
      store: Object.assign({}, store),
      snapshot,
      section: this._generateSection(step.metaStep),
      metaStep: this._mapMetaStep(step.metaStep),
      returnValue: step.returnValue,
      command: step.command,
      stack
    };
  }

  _emitMetaStepChangedIfNecessary() {
    if (!isEqualMetaStep(this.step.metaStep, this.metaStep)) {
      // append changed metastep to list 
      // NOTE this.metaStep can be null which means "no metastep"
      if (this.step.metaStep) {
        wsEvents.rtr.metaStepChanged(this._mapMetaStep(this.step.metaStep, true));
      }
      this.metaStep = this.step.metaStep;
    }
  }

  async _reportStep(step) {
    if (!step) return;
    let snapshot;

    const helper = this._getHelper();

    recorder.add('take snapshot', async () => {
      snapshot = await takeSnapshot(helper, this.stepIndex, isScreenshotStep(step));
    });
    // we take source in another promise to allow it to be retried
    recorder.add('take source', async () => {
      snapshot.source = await grabSource(helper);
      snapshotStore.add(this.stepIndex, snapshot );
    });      
    
    recorder.add('send event to websockets', () => {
      wsEvents.rtr.stepAfter(
        this._mapStep({
          testStartedAt: this.testStartedAt, 
          id: this.stepIndex,
          step,
          snapshot,
        })
      );
    });
  }

  async _beforeSuite(suite) {  
    if (!this._isEnabled()) return;
    this.suite = suite; 
   
    wsEvents.rtr.suiteBefore(mapSuiteAndTest(Date.now(), this.suite, this.test));
  }

  async _before(t) {
    if (!this._isEnabled(t)) return;

    t.retries(0); // disable retries in web ui
    this.test = t;
    this.testStartedAt = Date.now();
    this.stepIndex = 0;
    this.step = undefined;
    this.metaStep = undefined;
    this.loggedMetaSteps = [];
    this.cachedStackFrameInTest = undefined;

    // ignore context errors for Puppeteer
    if (this.helpers['Puppeteer']) {
      recorder.retry({
        retries: 5,
        when: err => err.message.indexOf('context') > -1, // ignore context errors
      });
    }

    wsEvents.rtr.testBefore(mapSuiteAndTest(this.testStartedAt, this.suite, this.test));
  }

  async _after(t) {
    if (!this._isEnabled(t)) return;

    wsEvents.rtr.testAfter(mapSuiteAndTest(this.testStartedAt, this.suite, this.test));
  }

  async _passed() {
    if (!this._isEnabled(this.test)) return;

    wsEvents.rtr.testPassed({
      id: this.stepIndex,
      testStartedAt: this.testStartedAt,
      testId: this.test.id,
      duration: (Date.now() - this.testStartedAt) / 1000,
    });

    scenarioStatusRepository.setStatus(this.test.id, {
      status: 'passed',
      startedAt: this.test.testStartedAt,
      duration: this.test.duration,
    });
  }


  _finishTest() {
    debug('finishTest');
    if (!this._isEnabled(this.test)) return;

    wsEvents.rtr.testRunFinished();
  }
}

module.exports = RealtimeReporterHelper;
