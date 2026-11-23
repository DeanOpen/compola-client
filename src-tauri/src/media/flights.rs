//! Shared in-flight work (Swift `MediaLoader.join`): concurrent requests for the same key share one future, which
//! is dropped — cancelling the download — once every waiter has gone away.

use std::collections::HashMap;
use std::future::Future;

use futures_util::future::{BoxFuture, FutureExt, Shared, WeakShared};
use parking_lot::Mutex;

pub struct Flights<T: Clone> {
    map: Mutex<HashMap<String, WeakShared<BoxFuture<'static, T>>>>,
}

impl<T: Clone> Default for Flights<T> {
    fn default() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }
}

impl<T: Clone + Send + Sync + 'static> Flights<T> {
    /// Joins the flight for `key`, starting it with `start` when none is running.
    pub async fn join<F, Fut>(&self, key: &str, start: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T> + Send + 'static,
    {
        let shared: Shared<BoxFuture<'static, T>> = {
            let mut map = self.map.lock();
            match map.get(key).and_then(WeakShared::upgrade) {
                Some(existing) => existing,
                None => {
                    let flight = start().boxed().shared();
                    if map.len() >= 256 {
                        map.retain(|_, w| w.upgrade().is_some());
                    }
                    if let Some(weak) = flight.downgrade() {
                        map.insert(key.to_owned(), weak);
                    }
                    flight
                }
            }
        };
        let out = shared.clone().await;
        let mut map = self.map.lock();
        if map.get(key).and_then(WeakShared::upgrade).is_some_and(|current| current.ptr_eq(&shared)) {
            map.remove(key);
        }
        out
    }

    /// Number of keys with a live flight (tests).
    #[cfg(test)]
    pub fn live(&self) -> usize {
        self.map.lock().values().filter(|w| w.upgrade().is_some()).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn concurrent_callers_share_one_run() {
        let flights = Arc::new(Flights::<usize>::default());
        let runs = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..5 {
            let (flights, runs) = (flights.clone(), runs.clone());
            tasks.push(tokio::spawn(async move {
                flights
                    .join("k", || async move {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        runs.fetch_add(1, Ordering::SeqCst) + 1
                    })
                    .await
            }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap(), 1);
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert_eq!(flights.live(), 0);
        // A later call starts a new flight.
        let again = flights.join("k", || async { 7 }).await;
        assert_eq!(again, 7);
    }

    #[tokio::test]
    async fn dropped_waiters_cancel_the_work() {
        let flights = Arc::new(Flights::<()>::default());
        let finished = Arc::new(AtomicUsize::new(0));
        let f2 = finished.clone();
        let fl = flights.clone();
        let task = tokio::spawn(async move {
            fl.join("slow", || async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                f2.fetch_add(1, Ordering::SeqCst);
            })
            .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        task.abort();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(finished.load(Ordering::SeqCst), 0);
        assert_eq!(flights.live(), 0);
    }
}
